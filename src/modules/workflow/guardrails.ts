// The rules of package C (BL-WFE-003) that the definition transitions apply; kept out of transitions/*.ts so that
// every export there is a named, tested transition (ARCH-014).
//
// Who is a second person for an approval-path change (DEC-PO-146 / ADR-0011, DEC-PO-147; INV-IAM-01 / ADR-0010).
// The authors of the change are, for an activation, the draft's creator and last editor, and for a retirement that
// loosens a control, the person who asked for it. The actor (activator, confirmer) is NOT a second person when:
//   AUTHOR_ACTIVATED          an author is the actor himself, or on the actor's side, or the actor on the author's
//                             side, where a side is iam.attesterSide (the account, its upward attestation chain, and
//                             every account it created, transitively: DEC-PO-142, the CREATOR_IS_SECOND_PERSON
//                             principle). So an admin who writes a path through an account he created, and activates
//                             it with his own, is one person. Fail closed: an author who does not count toward
//                             ENFORCED (unattested, a vendor account, an unknown login) is not a second person's work
//                             either.
//   UNATTESTED_SECOND_PERSON  the actor does not count toward ENFORCED (iam countsTowardEnforced).
// ENFORCED refuses either; SINGLE_OPERATOR accepts them (recorded SELF_ACT) only when no other eligible editor could act,
// where "other" applies the same side rule to the authors and to the actor.
import { attesterSide, countsTowardEnforced, identityOf } from '@/modules/iam';
import type { OperatorMode, TxClient } from '@/modules/platform';

/** Why the actor is not a valid second person (empty: he is). Owner-digest reason names (platform SELF_ACT). */
export type ActivationSelfActReason = 'AUTHOR_ACTIVATED' | 'UNATTESTED_SECOND_PERSON';

/**
 * Pure: the reasons `activatorId` is not a second person for a draft created by `createdById` and last edited by
 * `lastEditedById` (null: the creator), given whether he counts toward ENFORCED and whether an author is on his side
 * (`authorOnActorSide`, from authorsOnActorSide).
 */
export function activationSelfActReasons(
  d: { createdById: string; lastEditedById: string | null },
  activatorId: string,
  activatorCounts: boolean,
  authorOnActorSide = false,
): ActivationSelfActReason[] {
  const out: ActivationSelfActReason[] = [];
  if (authorOnActorSide || activatorId === d.createdById || activatorId === (d.lastEditedById ?? d.createdById)) out.push('AUTHOR_ACTIVATED');
  if (!activatorCounts) out.push('UNATTESTED_SECOND_PERSON');
  return out;
}

/**
 * Pure: refused in ENFORCED; in SINGLE_OPERATOR an author's own act is accepted only when no other eligible editor exists
 * (`otherEditors` = 0), and a distinct but unattested actor is accepted. Returns the refusal, or null.
 */
export function activationRefusal(reasons: readonly ActivationSelfActReason[], mode: OperatorMode, otherEditors: number): string | null {
  if (!reasons.length) return null;
  if (mode !== 'SINGLE_OPERATOR') return `ENFORCED: ${reasons.join(', ')}`;
  if (reasons.includes('AUTHOR_ACTIVATED') && otherEditors > 0) return 'SINGLE_OPERATOR: another eligible editor can act on this version';
  return null;
}

/** Are these two accounts one side (either is in the other's iam.attesterSide)? */
async function sameSide(tx: TxClient, a: string, b: string, sides: Map<string, Set<string>>): Promise<boolean> {
  if (a === b) return true;
  const sideOf = async (id: string) => {
    let s = sides.get(id);
    if (!s) {
      s = await attesterSide(tx, { id });
      sides.set(id, s);
    }
    return s;
  };
  return (await sideOf(a)).has(b) || (await sideOf(b)).has(a);
}

/**
 * Whose work the change is, from the actor's point of view: `tied` when an author is the actor or on his side (either
 * direction); `unattestedAuthor` when an author does not count toward ENFORCED (fail closed: unattested authorship is
 * not a second person's work). Either makes the act AUTHOR_ACTIVATED; only `tied` asks for another editor in
 * SINGLE_OPERATOR (an untied actor is as good a second person as anyone else there).
 */
export async function authorshipOf(
  tx: TxClient,
  authors: readonly string[],
  actorId: string,
  sides = new Map<string, Set<string>>(),
): Promise<{ tied: boolean; unattestedAuthor: boolean }> {
  let tied = false;
  let unattestedAuthor = false;
  for (const a of new Set(authors)) {
    const u = await identityOf(tx, a);
    if (!u || !countsTowardEnforced(u)) unattestedAuthor = true;
    if (!tied && (await sameSide(tx, a, actorId, sides))) tied = true;
  }
  return { tied, unattestedAuthor };
}

/**
 * How many of `editors` (eligible editors of the company, iam) could be the second person instead: not the actor, not
 * an author, and on no author's or the actor's side.
 */
export async function otherSecondPersons(tx: TxClient, editors: readonly string[], authors: readonly string[], actorId: string, sides = new Map<string, Set<string>>()): Promise<number> {
  let n = 0;
  for (const e of new Set(editors)) {
    if (e === actorId || authors.includes(e)) continue;
    let tied = await sameSide(tx, e, actorId, sides);
    for (const a of authors) if (!tied) tied = await sameSide(tx, e, a, sides);
    if (!tied) n += 1;
  }
  return n;
}
