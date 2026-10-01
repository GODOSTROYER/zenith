#!/usr/bin/env python3
"""Independent AWS Signature Version 4 reference used to cross-check the Go
signer. Written from the public specification with the standard library only;
it shares no code with the Go implementation. It is a test aid, not shipped."""
import hashlib
import hmac
import json
import posixpath
import sys
from urllib.parse import quote, unquote_plus

ACCESS_KEY = "AKIDEXAMPLE"
SECRET_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def hmac_sha256(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def enc(s: str, keep_slash: bool) -> str:
    return quote(s, safe="/-_.~" if keep_slash else "-_.~")


def canonical_uri(wire_path: str, s3: bool) -> str:
    if wire_path == "":
        return "/"
    if s3:
        return wire_path
    trailing = wire_path.endswith("/")
    norm = posixpath.normpath(wire_path)
    if norm.startswith("//"):  # posixpath keeps a leading double slash
        norm = "/" + norm.lstrip("/")
    if trailing and norm != "/":
        norm += "/"
    return enc(norm, True)


def canonical_query(raw: str) -> str:
    if raw == "":
        return ""
    pairs = []
    for part in raw.split("&"):
        if part == "":
            continue
        k, _, v = part.partition("=")
        pairs.append((enc(unquote_plus(k), False), enc(unquote_plus(v), False)))
    pairs.sort()
    return "&".join(f"{k}={v}" for k, v in pairs)


def sign(case):
    t = case["time"]  # e.g. 20260930T120000Z
    day = t[:8]
    headers = {k.lower(): " ".join(v.split()) for k, v in case["headers"].items()}
    headers["host"] = case["host"]
    headers["x-amz-date"] = t
    body = case.get("body", "").encode("utf-8")
    payload_hash = sha256_hex(body)
    if case.get("sessionToken"):
        headers["x-amz-security-token"] = case["sessionToken"]
    if case.get("s3"):
        headers["x-amz-content-sha256"] = payload_hash
    names = sorted(headers)
    canon_headers = "".join(f"{n}:{headers[n]}\n" for n in names)
    signed = ";".join(names)
    creq = "\n".join([
        case["method"],
        canonical_uri(case["path"], case.get("s3", False)),
        canonical_query(case["query"]),
        canon_headers,
        signed,
        payload_hash,
    ])
    scope = f"{day}/{case['region']}/{case['service']}/aws4_request"
    sts = "\n".join(["AWS4-HMAC-SHA256", t, scope, sha256_hex(creq.encode("utf-8"))])
    k = hmac_sha256(("AWS4" + SECRET_KEY).encode("utf-8"), day)
    k = hmac_sha256(k, case["region"])
    k = hmac_sha256(k, case["service"])
    k = hmac_sha256(k, "aws4_request")
    sig = hmac.new(k, sts.encode("utf-8"), hashlib.sha256).hexdigest()
    authz = f"AWS4-HMAC-SHA256 Credential={ACCESS_KEY}/{scope}, SignedHeaders={signed}, Signature={sig}"
    out = dict(case)
    out.update({"canonicalRequest": creq, "stringToSign": sts, "signature": sig, "authorization": authz})
    return out


CASES = [
    {
        "name": "dynamodb-json-post-x-amz-target",
        "method": "POST", "host": "dynamodb.us-west-2.amazonaws.com", "path": "/", "query": "",
        "headers": {"Content-Type": "application/x-amz-json-1.0", "X-Amz-Target": "DynamoDB_20120810.ListTables"},
        "body": "{}", "service": "dynamodb", "region": "us-west-2", "time": "20260930T120000Z",
    },
    {
        "name": "ec2-query-post-session-token",
        "method": "POST", "host": "ec2.eu-west-1.amazonaws.com", "path": "/", "query": "",
        "headers": {"Content-Type": "application/x-www-form-urlencoded; charset=utf-8"},
        "body": "Action=DescribeInstances&Version=2016-11-15&Filter.1.Name=instance-state-name&Filter.1.Value.1=running",
        "service": "ec2", "region": "eu-west-1", "time": "20260930T120000Z",
        "sessionToken": "IQoJb3JpZ2luX2VjEXAMPLETOKEN//////////wEaCXVzLWVhc3QtMSJH",
    },
    {
        "name": "lambda-rest-get-encoded-path-duplicate-query",
        "method": "GET", "host": "lambda.us-east-1.amazonaws.com",
        "path": "/2015-03-31/functions/my%20func%2Fname/invocations",
        "query": "Qualifier=$LATEST&x=a+b&x=a%20b&B=2&a=1",
        "headers": {"Accept": "application/json"},
        "body": "", "service": "lambda", "region": "us-east-1", "time": "20260930T120000Z",
    },
    {
        "name": "s3-style-get-object-encoded-key",
        "method": "GET", "host": "examplebucket.s3.amazonaws.com",
        "path": "/photos/2026%20report%2Bfinal.pdf", "query": "versionId=abc",
        "headers": {"Range": "bytes=0-9"},
        "body": "", "service": "s3", "region": "us-east-1", "time": "20260930T120000Z", "s3": True,
    },
    {
        "name": "s3-style-put-with-body-and-dot-segment-kept",
        "method": "PUT", "host": "examplebucket.s3.eu-west-1.amazonaws.com",
        "path": "/a//b/./c.txt", "query": "",
        "headers": {"Content-Type": "text/plain"},
        "body": "hello world", "service": "s3", "region": "eu-west-1", "time": "20260930T120000Z", "s3": True,
    },
]

if __name__ == "__main__":
    json.dump([sign(c) for c in CASES], sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
