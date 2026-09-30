# Test data provenance

`aws4_testsuite/` is a subset of the **AWS Signature Version 4 test suite**
(Copyright 2019 Amazon.com, Inc. or its affiliates; Apache License 2.0),
copied unmodified from the copy vendored by the botocore project:
<https://github.com/boto/botocore/tree/develop/tests/unit/auth/aws4_testsuite>
(each case: `.req` request, `.creq` canonical request, `.sts` string to sign,
`.authz` expected Authorization header). The cases reproduced are the GET
vanilla / query-ordering / unreserved / UTF-8 / header-trim / multi-line /
session-token cases, the path-normalization cases and the POST cases.

`independent-vectors.json` is NOT from AWS. It was produced by
`sigv4_reference.py`, a from-the-spec Python implementation written
independently of the Go code (standard library only), for cases the public
suite does not cover: a JSON-protocol POST with `X-Amz-Target`, a query
protocol POST with a session token, a REST GET with an encoded path and
duplicate query parameters, and an S3-style request. Regenerate with:

    python3 sigv4_reference.py > independent-vectors.json
