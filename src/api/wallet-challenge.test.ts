import { describe, expect, it } from "vitest";
import { WalletChallenges } from "./wallet-challenge.js";

const A = "rNasjPPz3pA637wAfr25xedCoDVrwDDzU6";
const B = "rwPy1pJd3RcHrEaqKk1yUiEGCqz8wewJZm";

describe("WalletChallenges", () => {
  it("accepts its own challenge, for the event and address it named", () => {
    const c = new WalletChallenges("secret");
    const { challenge, expiresAt } = c.issue(700013, A);
    expect(c.check(challenge, 700013, A)).toBe("ok");
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
  });

  it("refuses it for another event or another address", () => {
    const c = new WalletChallenges("secret");
    const { challenge } = c.issue(700013, A);
    expect(c.check(challenge, 700014, A)).toBe("invalid");
    expect(c.check(challenge, 700013, B)).toBe("invalid");
  });

  it("refuses one that was edited, or made with another secret", () => {
    const c = new WalletChallenges("secret");
    const { challenge } = c.issue(700013, A);
    const edited = challenge.replace(`.${A}.`, `.${B}.`);
    expect(c.check(edited, 700013, B)).toBe("invalid");
    expect(new WalletChallenges("other").check(challenge, 700013, A)).toBe("invalid");
    expect(c.check("not-a-challenge", 700013, A)).toBe("invalid");
  });

  it("survives a restart when the secret does", () => {
    const { challenge } = new WalletChallenges("secret").issue(700013, A);
    expect(new WalletChallenges("secret").check(challenge, 700013, A)).toBe("ok");
  });

  it("expires", () => {
    let now = 1_000_000;
    const c = new WalletChallenges("secret", 60_000, () => now);
    const { challenge } = c.issue(700013, A);
    now += 60_000;
    expect(c.check(challenge, 700013, A)).toBe("expired");
  });
});
