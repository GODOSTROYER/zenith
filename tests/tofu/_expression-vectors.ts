/** Harmless SEC-F5 payloads: read only the generated version pin, never secrets. */
const commentForms = ["/**/", " /* c */ ", " # c\n", " // c\n"];
export const secVectors = [
  ...["file", "templatefile", "fileexists"].flatMap((fn) => {
    const call = (comment: string) => `${fn}${comment}("versions.tf.json"${fn === "templatefile" ? ", {}" : ""})`;
    return [
      ...commentForms.map((c) => `\${${call(c)}}`),
      `\${try(${call("/**/")}, "x")}`,
      `%{ if true }\${${call("/**/")}}%{ endif }`,
    ];
  }),
  "${path . cwd}", "${path/**/.cwd}", "${path . module}", "${path\n.cwd}",
];

/** Valid templates for a batched differential plan using a harmless oracle. */
export const upperCorpus = [
  'plain upper("zz")', "literal {} # // /* */ \\ text", "héllo 🌍",
  '${upper("zz")}', '${upper/**/("zz")}', '${upper /* c */ ("zz")}',
  '${upper # c\n("zz")}', '${upper // c\n("zz")}',
  '${~ upper("zz") ~}', '${try(upper("zz"), "x")}',
  '%{ if true }${upper("zz")}%{ else }none%{ endif }',
  '%{~ for v in ["zz"] ~}${upper(v)}%{~ endfor ~}',
  '${join(",", [for v in ["zz"] : upper(v) if true])}',
  '${jsonencode({path = upper("zz"), terraform = "literal"})}',
  '${"inside ${upper("zz")}"}',
  '${"unicode \\u0024{upper(\\"zz\\")}"}',
  '${<<EOT\n${upper("zz")}\nEOT\n}',
  '${<<-EOT\n  ${upper("zz")}\n  EOT\n}',
  '${<<EOT\n${<<INNER\n${upper("zz")}\nINNER\n}\nEOT\n}',
  ...Array.from({ length: 8 }, (_, n) => `${"$".repeat(n + 1)}{upper("zz")}`),
  ...Array.from({ length: 8 }, (_, n) => `${"%".repeat(n + 1)}{ if true }zz${"%".repeat(n + 1)}{ endif }`),
  '$${upper("zz")}', '%%{ if }',
  '${"$${upper(\\"zz\\")}"}',
  '${"backslash \\\\ ${upper("zz")}"}',
  '${upper("zz") == "ZZ" ? upper("zz") : "no"}',
  '${jsonencode({for k, v in {z = "zz"} : k => upper(v)})}',
  '${upper("zz")}$$${upper("zz")}',
];
