// Touch ID presence helper for the Human Touch gate.
//
// A tier-1 LOCAL presence check, not a security boundary: it proves a human is
// at this machine, nothing more. The engine accepts /api/resolve with no proof
// of presence attached, so this must never be cited as one.
//
// Exit codes (classified by the CLI's presence-gate runner):
//   0 — fingerprint succeeded
//   1 — fingerprint failed/cancelled, or biometrics locked out (fail CLOSED)
//   2 — biometrics unavailable: no sensor, not enrolled, or access denied to
//       this binary (fail open; the CLI notes it once so it isn't silent)
//
// Build with `just build-presence-helper` (macOS only). The binary is a local
// POC artifact — gitignored, never committed or distributed.

import LocalAuthentication

let context = LAContext()
var probeError: NSError?
guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &probeError) else {
    // Lockout (biometrics disabled after too many failed attempts) is the exact
    // adversarial state the gate must resist — someone fumbling the sensor to
    // exhaustion must NOT turn the gate off. Treat it as a non-confirmation
    // (exit 1, fail closed), distinct from genuinely-unavailable biometrics
    // (exit 2, fail open).
    exit(probeError?.code == LAError.biometryLockout.rawValue ? 1 : 2)
}

// Names a presence check, not a security boundary. macOS
// renders this as: "habenula-presence" is trying to <reason>.
let reason = "confirm you're present to approve this action"

let semaphore = DispatchSemaphore(value: 0)
var confirmed = false
context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { ok, _ in
    confirmed = ok
    semaphore.signal()
}
semaphore.wait()
exit(confirmed ? 0 : 1)
