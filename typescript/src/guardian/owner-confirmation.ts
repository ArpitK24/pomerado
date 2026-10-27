import { createHash } from "node:crypto";
import { Effect, Option } from "effect";
import type { PendingExecution, ReviewTurn } from "./review.js";
import type { ConfirmedStepQuestion } from "./question.js";
import { completeSource } from "./source.js";

/**
 * The owner's yes to a confirm question, bound to the step an execution review held for it. The
 * host states it to the next review of that same step as `trusted_authority.ownerConfirmedStep`.
 */
export interface OwnerConfirmedStep {
  /** The confirm question the owner answered yes. */
  readonly questionId: string;
  /** The execution review that held the step for the owner's confirmation. */
  readonly reviewId: string;
}

/** A held step a confirm question names, as its question review sees it. */
export interface HeldStepQuestion extends ConfirmedStepQuestion {
  /** The holding review's rationale: why it asked for the owner's confirmation. */
  readonly rationale: string;
}

/**
 * What one step is, for telling whether the owner confirmed it: its entrypoint, purpose and
 * target, its screened input, and the screened text of each file it loads (the entrypoint and the
 * host's import closure). Undefined when a file cannot be read whole, so a step whose code cannot
 * be compared never matches a confirmation.
 */
export const stepIdentity = (
  pending: PendingExecution,
  readSource: ReviewTurn["readSource"],
): Effect.Effect<string | undefined> => {
  const paths = [
    ...new Set([pending.entrypoint, ...(pending.mintContext?.executedSources ?? [])]),
  ].sort();
  return Effect.forEach(paths, (path) => completeSource(readSource, path), {
    concurrency: 4,
  }).pipe(
    Effect.map((texts) =>
      texts.some((text) => text === undefined)
        ? undefined
        : createHash("sha256")
            .update(
              JSON.stringify({
                entrypoint: pending.entrypoint,
                purpose: pending.mintContext?.currentExecution?.purpose ?? null,
                target: pending.mintContext?.currentExecution?.target ?? null,
                input: pending.screenedInput,
                files: paths.map((path, index) => [path, texts[index]]),
              }),
              "utf8",
            )
            .digest("hex"),
    ),
    // error-reporting-allow: typed-recovery unreadable code matches no confirmation
    Effect.option,
    Effect.map(Option.getOrUndefined),
  );
};

/**
 * One job's owner confirmations, as Guardian keeps them between reviews. An execution review
 * that holds a step for the owner's confirmation records the step (`hold`); a question review that
 * allows a confirm question naming that review records the question (`asked`); and an execution
 * review of a step finds the confirmation the owner gave for exactly that step (`confirmedFor`).
 * Only the owner's yes, through the host's own answers to an allowed question, binds: never text a
 * page, a step result or the agent wrote.
 */
export const makeOwnerConfirmations = () => {
  /** Each held step's identity and the holding review's rationale, by that review's id. */
  const held = new Map<string, { readonly step: string; readonly rationale: string }>();
  /** Each allowed confirm question's prompt and the review whose step it confirms, by its id. */
  const questions = new Map<string, { readonly prompt: string; readonly reviewId: string }>();
  return {
    hold: (reviewId: string, step: string, rationale: string) => {
      held.set(reviewId, { step, rationale });
    },
    /** The marked confirm questions of a proposed request that name a step a review held. */
    heldStepQuestions: (
      candidate: NonNullable<PendingExecution["questionCandidate"]>,
    ): readonly HeldStepQuestion[] =>
      (candidate.confirms ?? []).flatMap(({ questionId, reviewId }) => {
        const step = held.get(reviewId);
        const question = candidate.questions.find((asked) => asked.id === questionId);
        return step === undefined || question?.type !== "confirm"
          ? []
          : [{ questionId, reviewId, rationale: step.rationale }];
      }),
    /** Records the confirm questions a question review allowed. */
    asked: (
      candidate: NonNullable<PendingExecution["questionCandidate"]>,
      bound: readonly HeldStepQuestion[],
    ) => {
      for (const { questionId, reviewId } of bound) {
        const question = candidate.questions.find((asked) => asked.id === questionId);
        if (question !== undefined)
          questions.set(questionId, { prompt: question.prompt, reviewId });
      }
    },
    /** Whether any allowed confirm question could bind, so a review without one reads nothing. */
    pending: (pending: PendingExecution) =>
      questions.size > 0 &&
      (pending.answeredQuestions ?? []).some(
        ({ id }) => id !== undefined && questions.has(id),
      ),
    /**
     * The owner's yes that confirms the step whose identity is `step`: an answer, by the host, to
     * an allowed confirm question with the same id and prompt, that confirms, for the step its
     * review held, when that step is this one.
     */
    confirmedFor: (pending: PendingExecution, step: string): OwnerConfirmedStep | undefined => {
      for (const { id, question, answer } of pending.answeredQuestions ?? []) {
        const asked = id === undefined ? undefined : questions.get(id);
        if (
          id === undefined ||
          asked === undefined ||
          asked.prompt !== question ||
          typeof answer !== "object" ||
          Array.isArray(answer) ||
          !("confirmed" in answer) ||
          answer.confirmed !== true ||
          held.get(asked.reviewId)?.step !== step
        )
          continue;
        return { questionId: id, reviewId: asked.reviewId };
      }
      return undefined;
    },
  };
};
