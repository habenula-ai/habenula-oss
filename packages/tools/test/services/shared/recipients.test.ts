import { describe, it, expect } from "vitest";
import {
  collectRecipients,
  NO_RECIPIENTS_NOUN,
  recipientAddress,
  recipientAddressesNoun,
  recipientDomain,
} from "../../../src/services/shared/recipients";

/**
 * The recipient parsing rules for send-shaped nouns as pure-function
 * tables. recipientAddress / recipientAddressesNoun
 * pin the grant grain: the noun is the exact lower-cased recipient-address
 * set, unparseable addresses fail closed to an opaque token, and any change
 * to the set re-confirms (per-address subset coverage is a tracked follow-up).
 * recipientDomain remains the calendar invitee noun's parser and keeps its
 * own table.
 */
describe("recipientDomain", () => {
  const cases: [string, string][] = [
    ["alice@acme.com", "acme.com"],
    ["ALICE@ACME.COM", "acme.com"],
    ["Alice Jones <alice@acme.com>", "acme.com"],
    ['"Jones, Alice" <alice@acme.com>', "acme.com"],
    // Domain is the substring after the LAST @ — a local part carrying an @
    // cannot smuggle a wrong domain.
    ["a@b@acme.com", "acme.com"],
    // Distinct hosts stay distinct (errs toward re-confirmation).
    ["alice@mail.acme.com", "mail.acme.com"],
    // Fail-closed: anything that doesn't parse to a plausible domain becomes
    // an opaque colon-bearing token that can never match a domain grant.
    ["not-an-address", "unparseable:not-an-address"],
    ["@acme.com", "unparseable:@acme.com"],
    ["alice@", "unparseable:alice@"],
    ["alice@acme .com", "unparseable:alice@acme .com"],
    // A bare display name without angle brackets must not read as an address.
    ["Alice alice@acme.com", "unparseable:alice alice@acme.com"],
    ["<>", "unparseable:<>"],
    // A colon-bearing "domain" fails closed — no real domain contains `:`.
    // This rejection keeps the colon-prefixed noun namespaces unforgeable:
    // without it, x@calendar:primary would mint the calendar write noun's
    // quiet-write fallback (`calendar:<name>`), and a@unparseable:junk would
    // mint the fail-closed token of the genuinely unparseable "junk".
    ["x@calendar:primary", "unparseable:x@calendar:primary"],
    ["a@unparseable:junk", "unparseable:a@unparseable:junk"],
  ];

  it.each(cases)("parses %j to %j", (address, domain) => {
    expect(recipientDomain(address)).toBe(domain);
  });
});

describe("recipientAddress", () => {
  const cases: [string, string][] = [
    ["alice@acme.com", "alice@acme.com"],
    // Lower-cased on parse, so casing variants dedupe to one grant subject
    // (policy matching is case-insensitive anyway).
    ["ALICE@ACME.COM", "alice@acme.com"],
    ["Alice Jones <alice@acme.com>", "alice@acme.com"],
    ['"Jones, Alice" <alice@acme.com>', "alice@acme.com"],
    // The full address IS the noun — an @ in the local part has nothing to
    // smuggle at this grain; the exact transmitted string is what a grant
    // names.
    ["a@b@acme.com", "a@b@acme.com"],
    // Fail-closed: anything that doesn't parse to a plausible address
    // becomes an opaque colon-bearing token that can never match a grant.
    ["not-an-address", "unparseable:not-an-address"],
    ["@acme.com", "unparseable:@acme.com"],
    ["alice@", "unparseable:alice@"],
    ["alice@acme .com", "unparseable:alice@acme .com"],
    // A bare display name without angle brackets must not read as an address.
    ["Alice alice@acme.com", "unparseable:alice alice@acme.com"],
    ["<>", "unparseable:<>"],
    // A comma-bearing (quoted) local part fails closed — the comma is the
    // noun's set separator, and a comma inside one address would corrupt the
    // joined set.
    ['"a,b"@acme.com', 'unparseable:"a,b"@acme.com'],
    // Colon-bearing parts fail closed on either side of the @ — a noun
    // containing `:` is always an opaque fail-closed token, never a
    // grantable mailbox, which keeps the colon-prefixed namespaces
    // (unparseable:, calendar:) unforgeable.
    ["a:b@acme.com", "unparseable:a:b@acme.com"],
    ["x@calendar:primary", "unparseable:x@calendar:primary"],
  ];

  it.each(cases)("parses %j to %j", (address, expected) => {
    expect(recipientAddress(address)).toBe(expected);
  });
});

describe("collectRecipients", () => {
  it("accepts an array, a comma-separated string, and absent values", () => {
    expect(collectRecipients(["a@x.com", "b@y.com"])).toEqual([
      "a@x.com",
      "b@y.com",
    ]);
    expect(collectRecipients("a@x.com, b@y.com")).toEqual([
      "a@x.com",
      "b@y.com",
    ]);
    expect(collectRecipients(undefined)).toEqual([]);
    expect(collectRecipients([])).toEqual([]);
  });

  it("keeps non-string entries as string forms (bound for the unparseable token) rather than dropping them", () => {
    expect(collectRecipients([42])).toEqual(["42"]);
    expect(recipientDomain("42")).toBe("unparseable:42");
  });

  it("splits on commas OUTSIDE double quotes — a quoted display name stays one recipient", () => {
    // `"Last, First" <a@x>` is a single RFC 5322 recipient; the comma is
    // inside the quoted display name, not a list separator.
    expect(collectRecipients('"Jones, Alice" <alice@acme.com>')).toEqual([
      '"Jones, Alice" <alice@acme.com>',
    ]);
    // Real separators outside quotes still split.
    expect(
      collectRecipients('"Jones, Alice" <alice@acme.com>, bob@acme.com'),
    ).toEqual(['"Jones, Alice" <alice@acme.com>', "bob@acme.com"]);
  });
});

describe("recipientAddressesNoun", () => {
  it("collects every address across to+cc+bcc, de-duped, sorted, comma-joined", () => {
    expect(
      recipientAddressesNoun({
        to: ["alice@acme.com"],
        cc: ["bob@other.com", "carol@acme.com"],
        bcc: ["dan@zeta.org"],
      }),
    ).toBe("alice@acme.com,bob@other.com,carol@acme.com,dan@zeta.org");
  });

  it("same-domain addresses stay distinct — a new mailbox is a new noun", () => {
    // The grant grain is the exact address set: a grant minted for alice
    // never covers a later send to bob, even inside the same domain
    // (per-address subset coverage is a tracked follow-up).
    expect(
      recipientAddressesNoun({ to: ["alice@acme.com", "Bob <bob@acme.com>"] }),
    ).toBe("alice@acme.com,bob@acme.com");
    expect(recipientAddressesNoun({ to: ["bob@acme.com"] })).not.toBe(
      recipientAddressesNoun({ to: ["alice@acme.com"] }),
    );
  });

  it("casing variants of one mailbox dedupe to a single address", () => {
    expect(
      recipientAddressesNoun({ to: ["Alice@ACME.com", "alice@acme.com"] }),
    ).toBe("alice@acme.com");
  });

  it("a quoted display name with a comma nouns to one clean address, not a spurious unparseable token", () => {
    // Regression: a naive comma split tore `"Last, First" <a@x>` into a bogus
    // extra recipient, minting an `unparseable:"last` token in the noun and
    // forcing a needless re-confirmation. Quote-aware collection keeps it one
    // recipient — one clean address.
    expect(
      recipientAddressesNoun({ to: ['"Jones, Alice" <alice@acme.com>'] }),
    ).toBe("alice@acme.com");
    expect(
      recipientAddressesNoun({
        to: ['"Jones, Alice" <alice@acme.com>', "bob@acme.com"],
      }),
    ).toBe("alice@acme.com,bob@acme.com");
  });

  it("an unparseable recipient contributes its opaque token — never silently covered", () => {
    expect(
      recipientAddressesNoun({ to: ["alice@acme.com", "garbage"] }),
    ).toBe("alice@acme.com,unparseable:garbage");
  });

  it("zero recipients yields the fixed non-matching sentinel", () => {
    expect(recipientAddressesNoun({})).toBe(NO_RECIPIENTS_NOUN);
    expect(recipientAddressesNoun({ to: [] })).toBe(NO_RECIPIENTS_NOUN);
  });

  it("threading params never enter the recipient set", () => {
    // A reply's threadId/inReplyTo set headers only — the noun reads
    // to/cc/bcc and nothing else.
    expect(
      recipientAddressesNoun({
        to: ["alice@acme.com"],
        threadId: "t-123",
        inReplyTo: "<msg@other.com>",
      }),
    ).toBe("alice@acme.com");
  });
});
