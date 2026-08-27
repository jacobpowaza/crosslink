/**
 * Short Authentication String — a human-comparable verification code derived
 * from both parties' identity keys. Both devices display it during pairing;
 * a MITM cannot make the codes match without one of the private keys.
 *
 * Order-independent: pubs are sorted before hashing so both sides compute
 * the identical string regardless of role.
 */
import { utf8ToBytes } from "@crosslink/protocol";
import { deriveOkm } from "./crypto/primitives.js";

export function shortAuthString(appId: string, pubA: Uint8Array, pubB: Uint8Array): string {
  const [first, second] =
    compareBytes(pubA, pubB) <= 0 ? [pubA, pubB] : [pubB, pubA];
  const okm = deriveOkm(
    concat(first, second),
    utf8ToBytes("crosslink-sas-v1"),
    appId,
    6
  );
  const groups: string[] = [];
  for (let g = 0; g < 3; g++) {
    const n = ((okm[g * 2] << 8) | okm[g * 2 + 1]) % 1000;
    groups.push(String(n).padStart(3, "0"));
  }
  return groups.join(" ");
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
