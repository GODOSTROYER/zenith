"""Exact host/IP/port proxy. Never resolve a tenant-supplied arbitrary name."""
import ipaddress
import json
import select
import socket
import socketserver
import sys
import urllib.parse

def load(path):
    with open(path, encoding="utf8") as file:
        entries = json.load(file)
    allowed = {}
    for item in entries:
        host, address, port = item["host"], ipaddress.ip_address(item["ip"]), item["port"]
        if address.is_loopback or address.is_link_local or address.is_unspecified or not 1 <= port <= 65535:
            raise ValueError("unsafe destination")
        key = (host, port)
        if key in allowed:
            raise ValueError("ambiguous destination")
        allowed[key] = item
    return allowed

class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(10)
        line = self.rfile.readline(8193)
        if len(line) > 8192:
            return
        try:
            method, target, version = line.decode("ascii").strip().split(" ")
            headers = []
            for count in range(64):
                header = self.rfile.readline(8193)
                if len(header) > 8192:
                    raise ValueError()
                if header == b"\r\n":
                    break
                headers.append(header)
            else:
                raise ValueError()
            if method == "CONNECT":
                # URL parser handles ambiguous encodings/credentials. No wildcard or suffix matching.
                uri = urllib.parse.urlsplit("https://" + target)
                if uri.username or uri.password or uri.path or uri.query or uri.fragment:
                    raise ValueError()
                port = uri.port or 443
            else:
                uri = urllib.parse.urlsplit(target)
                if method not in ("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE") or uri.scheme != "http" or uri.username or uri.password or uri.fragment:
                    raise ValueError()
                port = uri.port or 80
            item = self.server.allowed.get((uri.hostname, port))
            if not item or (method == "CONNECT") != item["tls"]:
                raise ValueError()
            # Direct pinned IP dial avoids DNS rebinding and has no tenant-controlled DNS.
            remote = socket.create_connection((item["ip"], port), timeout=10)
        except (ValueError, UnicodeError, OSError):
            self.wfile.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            return
        with remote:
            if method == "CONNECT":
                self.wfile.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
                self.wfile.flush()
            else:
                # Refuse parser ambiguity and transfer encodings; retain registry upload bodies.
                clean = []
                for header in headers:
                    key = header.split(b":", 1)[0].lower()
                    if key in (b"transfer-encoding", b"upgrade"):
                        return
                    if key not in (b"host", b"proxy-authorization", b"proxy-connection", b"connection"):
                        clean.append(header)
                path = uri.path or "/"
                if uri.query:
                    path += "?" + uri.query
                remote.sendall((method + " " + path + " HTTP/1.1\r\nHost: " + uri.netloc + "\r\nConnection: close\r\n").encode("ascii") + b"".join(clean) + b"\r\n")
            # Read the exact socket, with no buffered body hiding bytes from the relay.
            peers = [self.connection, remote]
            while True:
                ready, _, _ = select.select(peers, [], [], 30)
                if not ready:
                    return
                for source in ready:
                    data = source.recv(65536)
                    if not data:
                        return
                    (remote if source is self.connection else self.connection).sendall(data)

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    # Unbuffered header reads preserve request bodies for the socket relay.
Handler.rbufsize = 0

if __name__ == "__main__":
    allowed = load(sys.argv[1])
    with Server(("0.0.0.0", int(sys.argv[2])), Handler) as server:
        server.allowed = allowed
        server.serve_forever()

