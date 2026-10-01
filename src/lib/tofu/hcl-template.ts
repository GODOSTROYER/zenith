/**
 * Security scanner for the HCL templates used in OpenTofu JSON expressions.
 * It parses expressions rather than deleting comments or guessing at names.
 * Nested quoted/heredoc templates share the same scanner and lexical scope.
 * Unknown syntax and excessive nesting fail closed; no diagnostic quotes input.
 * This validates syntax and collects dependencies, not HCL types or evaluation.
 */
export interface HclTemplateScan {
  calls: Set<string>;
  roots: Set<string>;
  /** True only when evaluation leaves the string byte-for-byte unchanged. */
  pureLiteral: boolean;
}

export class HclTemplateError extends Error {
  constructor(readonly offset: number) {
    super(`Unrecognized or unterminated HCL template at offset ${offset}.`);
    this.name = "HclTemplateError";
  }
}

interface Token { kind: string; text: string; end: number; newline: boolean }
const IDENT = /[_\p{ID_Start}][\p{ID_Continue}-]*/uy;
const NUMBER = /[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const PRECEDENCE: Record<string, number> = {
  "||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, ">": 4, "<=": 4, ">=": 4,
  "+": 5, "-": 5, "*": 6, "/": 6, "%": 6,
};
type Scope = ReadonlySet<string>;

class Scanner {
  private pos = 0;
  private depth = 0;
  readonly result: HclTemplateScan = { calls: new Set(), roots: new Set(), pureLiteral: true };
  constructor(private readonly source: string) {}

  private refuse(): never { throw new HclTemplateError(this.pos); }
  private enter(): void { if (++this.depth > 128) this.refuse(); }
  private at(text: string): boolean { return this.source.startsWith(text, this.pos); }

  private lex(start = this.pos): Token {
    let p = start;
    let newline = false;
    while (p < this.source.length) {
      const c = this.source[p];
      if (c === " " || c === "\t" || c === "\n" || (c === "\r" && this.source[p + 1] === "\n")) {
        newline ||= c === "\n";
        p++;
      } else if (c === "#" || this.source.startsWith("//", p)) {
        const end = this.source.indexOf("\n", p);
        p = end < 0 ? this.source.length : end;
      } else if (this.source.startsWith("/*", p)) {
        const end = this.source.indexOf("*/", p + 2);
        if (end < 0) this.refuse();
        p = end + 2;
      } else break;
    }
    if (p === this.source.length) return { kind: "eof", text: "", end: p, newline };
    IDENT.lastIndex = p;
    const id = IDENT.exec(this.source);
    if (id) return { kind: "id", text: id[0], end: IDENT.lastIndex, newline };
    NUMBER.lastIndex = p;
    const number = NUMBER.exec(this.source);
    if (number) return { kind: "number", text: number[0], end: NUMBER.lastIndex, newline };
    for (const op of ["<<-", "<<", "...", "::", "=>", "==", "!=", "<=", ">=", "&&", "||", "~}"]) {
      if (this.source.startsWith(op, p)) return { kind: op, text: op, end: p + op.length, newline };
    }
    const c = this.source[p];
    if ('"{}[]().,:?+-*/%!=<>'.includes(c)) return { kind: c, text: c, end: p + 1, newline };
    return this.refuse();
  }

  private peek(): Token { return this.lex(); }
  private take(): Token { const t = this.lex(); this.pos = t.end; return t; }
  private accept(kind: string): boolean {
    if (this.peek().kind !== kind) return false;
    this.take();
    return true;
  }
  private expect(kind: string): Token { if (this.peek().kind !== kind) this.refuse(); return this.take(); }
  private keyword(word: string): boolean { const t = this.peek(); return t.kind === "id" && t.text === word; }
  private expectWord(word: string): void { if (!this.keyword(word)) this.refuse(); this.take(); }

  private root(name: string, scope: Scope): void {
    if (!["true", "false", "null"].includes(name) && !scope.has(name)) this.result.roots.add(name);
  }

  private expression(scope: Scope, min = 0): void {
    this.enter();
    if (this.accept("!") || this.accept("-")) this.expression(scope, 7);
    else this.primary(scope);
    while ((PRECEDENCE[this.peek().kind] ?? -1) >= min) {
      const op = this.take().kind;
      this.expression(scope, PRECEDENCE[op] + 1);
    }
    if (min === 0 && this.accept("?")) {
      this.expression(scope);
      this.expect(":");
      this.expression(scope);
    }
    this.depth--;
  }

  private primary(scope: Scope): void {
    const t = this.take();
    switch (t.kind) {
      case "number": break;
      case '"': this.template(scope, "quote"); break;
      case "<<": case "<<-": this.heredoc(scope); break;
      case "(": this.expression(scope); this.expect(")"); break;
      case "[": this.collection(scope, false); break;
      case "{": this.collection(scope, true); break;
      case "id": {
        let name = t.text;
        while (this.accept("::")) name += `::${this.expect("id").text}`;
        if (this.accept("(")) {
          this.result.calls.add(name);
          if (!this.accept(")")) {
            do {
              this.expression(scope);
              if (this.accept("...")) { this.expect(")"); break; }
              if (this.accept(")")) break;
              this.expect(",");
            } while (!this.accept(")"));
          }
        } else {
          if (name.includes("::")) this.refuse();
          this.root(name, scope);
        }
        break;
      }
      default: this.refuse();
    }
    while (true) {
      if (this.accept(".")) {
        if (this.accept("*")) continue;
        const attr = this.take();
        if (attr.kind !== "id" && (attr.kind !== "number" || !/^[0-9]+$/.test(attr.text))) this.refuse();
      } else if (this.accept("[")) {
        if (!this.accept("*")) this.expression(scope);
        this.expect("]");
      } else break;
    }
  }

  private bindings(): string[] {
    const names = [this.expect("id").text];
    if (this.accept(",")) names.push(this.expect("id").text);
    if (new Set(names).size !== names.length) this.refuse();
    this.expectWord("in");
    return names;
  }

  private collection(scope: Scope, object: boolean): void {
    const end = object ? "}" : "]";
    if (this.accept(end)) return;
    if (this.keyword("for") && this.lex(this.peek().end).kind === "id") {
      this.take();
      const names = this.bindings();
      this.expression(scope);
      this.expect(":");
      const inner = new Set([...scope, ...names]);
      this.expression(inner);
      if (object) { this.expect("=>"); this.expression(inner); this.accept("..."); }
      if (this.keyword("if")) { this.take(); this.expression(inner); }
      this.expect(end);
      return;
    }
    while (true) {
      if (object) {
        // Only a single bare identifier directly followed by =/: is a literal
        // key. Parenthesized keys and traversals always remain expressions.
        const key = this.peek();
        const next = key.kind === "id" ? this.lex(key.end).kind : "";
        if (key.kind === "id" && (next === "=" || next === ":")) this.take();
        else this.expression(scope);
        if (!this.accept("=") && !this.accept(":")) this.refuse();
      }
      this.expression(scope);
      if (this.accept(end)) return;
      if (!this.accept(",") && !(object && this.peek().newline)) this.refuse();
      if (this.accept(end)) return;
    }
  }

  private heredoc(scope: Scope): void {
    // The introducer has no intervening trivia. HCL recognizes a closing
    // marker with surrounding spaces for both << and <<- heredocs.
    IDENT.lastIndex = this.pos;
    const match = IDENT.exec(this.source);
    if (!match) this.refuse();
    const marker = match[0];
    this.pos = IDENT.lastIndex;
    if (this.at("\r\n")) this.pos += 2;
    else if (this.at("\n")) this.pos++;
    else this.refuse();
    this.template(scope, "heredoc", marker);
  }

  private template(scope: Scope, mode: "bare" | "quote" | "heredoc", marker?: string): void {
    this.enter();
    let currentScope = scope;
    const controls: { kind: "if" | "for"; scope: Scope; elseSeen: boolean }[] = [];
    let lineStart = mode === "heredoc";
    while (this.pos < this.source.length) {
      if (mode === "quote" && this.at('"')) {
        if (controls.length) this.refuse();
        this.pos++; this.depth--; return;
      }
      if (mode === "heredoc" && lineStart) {
        const end = this.source.indexOf("\n", this.pos);
        // Use a conservative subset of Go's TrimSpace. In particular JS trim
        // removes a BOM, which HCL does not recognize as marker whitespace.
        if (end >= 0 && this.source.slice(this.pos, end).replace(/^[ \t\r]+|[ \t\r]+$/g, "") === marker) {
          if (controls.length) this.refuse();
          this.pos = end + 1; this.depth--; return;
        }
      }
      // Consume exactly the escape at the current position. In $$${ the
      // first dollar is text and the remaining $${ is the literal escape.
      if (this.at("$${") || this.at("%%{")) {
        this.result.pureLiteral = false;
        this.pos += 3; lineStart = false; continue;
      }
      if (this.at("${") || this.at("%{")) {
        const directive = this.at("%{");
        this.result.pureLiteral = false;
        this.pos += 2;
        if (this.at("~")) this.pos++;
        if (!directive) this.expression(currentScope);
        else {
          const word = this.expect("id").text;
          if (word === "if") {
            this.expression(currentScope);
            if (controls.length >= 128) this.refuse();
            controls.push({ kind: "if", scope: currentScope, elseSeen: false });
          } else if (word === "for") {
            const names = this.bindings();
            this.expression(currentScope);
            if (controls.length >= 128) this.refuse();
            controls.push({ kind: "for", scope: currentScope, elseSeen: false });
            currentScope = new Set([...currentScope, ...names]);
          } else {
            const control = controls.at(-1);
            if (!control) this.refuse();
            if (word === "else" && control.kind === "if" && !control.elseSeen) control.elseSeen = true;
            else if ((word === "endif" && control.kind === "if") || (word === "endfor" && control.kind === "for")) {
              currentScope = control.scope; controls.pop();
            } else this.refuse();
          }
        }
        if (!this.accept("~}")) this.expect("}");
        lineStart = false;
        continue;
      }
      if (mode === "quote" && this.at("\\")) {
        this.pos++;
        const escape = this.source[this.pos++];
        if (["n", "r", "t", '"', "\\"].includes(escape)) continue;
        const width = escape === "u" ? 4 : escape === "U" ? 8 : 0;
        if (!width) this.refuse();
        const hex = this.source.slice(this.pos, this.pos + width);
        if (hex.length !== width || !/^[0-9A-Fa-f]+$/.test(hex)) this.refuse();
        const code = parseInt(hex, 16);
        if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) this.refuse();
        this.pos += width;
        continue;
      }
      const c = this.source[this.pos++];
      if (mode === "quote" && (c === "\r" || c === "\n")) this.refuse();
      lineStart = c === "\n";
    }
    if (mode !== "bare" || controls.length) this.refuse();
    this.depth--;
  }

  scan(): HclTemplateScan { this.template(new Set(), "bare"); return this.result; }
}

export function scanHclTemplate(source: string): HclTemplateScan {
  return new Scanner(source).scan();
}
