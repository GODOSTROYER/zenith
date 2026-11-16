// Package protocol implements the wire contract shared by zenith-runner and
// zenithd (docs/platform/RUNNER-PROTOCOL.md): compact-JWS verification with
// pinned Ed25519 keys, job/machine envelopes, capability-grant claims, the
// request-signing string, and the persisted replay cache.
//
// Everything in this package is a pure function of its inputs (time and
// randomness are injected), so the same code is exercised by the golden
// vectors under testdata/ that the TypeScript control plane also tests.
package protocol

import "time"

const (
	// RunnerProtocol and MachineProtocol are the protocol ids embedded in
	// every envelope and in every signed request string.
	RunnerProtocol  = "zenith.runner/v1"
	MachineProtocol = "zenith.machine/v1"

	// JWS `typ` header values.
	TypJob     = "zenith-job+jwt"
	TypMachine = "zenith-machine+jwt"
	TypGrant   = "zenith-grant+jwt"

	// AlgEdDSA is the only accepted JWS algorithm.
	AlgEdDSA = "EdDSA"

	// APIPrefix is the REST prefix of every agent endpoint.
	APIPrefix = "/api/platform/v1"

	// Request-signing header names (spec section 3).
	HeaderAgent         = "X-Zenith-Agent"
	HeaderTimestamp     = "X-Zenith-Timestamp"
	HeaderNonce         = "X-Zenith-Nonce"
	HeaderContentSHA256 = "X-Zenith-Content-SHA256"
	HeaderSignature     = "X-Zenith-Signature"
)

const (
	// Skew is the clock tolerance applied to iat/exp of jobs and grants and
	// (server side) to request timestamps.
	Skew = 60 * time.Second

	// ReplayRetention is the minimum time a job id stays in the replay cache.
	ReplayRetention = 24 * time.Hour

	// MaxTokenBytes bounds a compact JWS before any decoding. Job payloads
	// carry base64 OpenTofu files, so the bound is generous but finite.
	MaxTokenBytes = 32 << 20
)
