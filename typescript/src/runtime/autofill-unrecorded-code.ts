import { Effect } from "effect";
import type {
  AutofillInspection,
  AutofillRefusal,
  AutofillStep,
} from "../destinations/autofill-step.js";
import { sameSite } from "./same-site.js";
import type { AutofillHooks } from "./autofill-state.js";

// A code screen the recipe never recorded: any site may ask for a code after the password, with or
// without two-factor when the tool was built. The replay looks once for one visible code field and
// its form's submit, or the field alone when it has none (`unrecordedCode` in autofill-replay.ts),
// only on a sign-in origin (`onSignInOrigin`).

/** Words in a field's name or id that alone name a one-time code. */
const oneTimeCodeWords = ["otp", "totp", "2fa", "mfa"];
/** Words in a field's name or id that name a one-time code only on a short numeric box. */
const codeWords = ["code", "verification"];
/**
 * Words in a field's name, id or autocomplete that name another kind of value, which win over the
 * words above: the one list to add such a word to, or `wholeOtherWords` when it sits inside common
 * names for a code box.
 */
const otherWords = [
  "password",
  "email",
  "username",
  "search",
  "zip",
  "postal",
  "post",
  "phone",
  "promo",
  "coupon",
  "discount",
  "gift",
  "voucher",
  "referral",
  "recovery",
  "backup",
  "captcha",
  "security",
  "confirmation",
  "access",
  "company",
  "country",
  "card",
  "cvv",
  "cvc",
  "csc",
  "pincode",
  "redeem",
  "area",
  "year",
];

/**
 * The code field and its form's submit, matched case-insensitively on attributes alone, never on
 * page text. A field marked
 * `autocomplete="one-time-code"` is one, whatever its name, as before. Only on a page with none, a
 * text, number or phone-digits box is one too when its name or id holds `oneTimeCodeWords`, or
 * holds `codeWords` and it is a short numeric box (`inputmode="numeric"`, or a number or phone
 * input, with a `maxlength` of 4 to 8), and neither its name, id nor autocomplete holds
 * `otherWords` (or `wholeOtherWords` as a word of its own, `findCodeField`), nor does its
 * autocomplete start with `tel` or `cc-`. A false match types a code where none belongs, such as a
 * voucher form's box, an image check's or a card's security code at a checkout, so this matches
 * narrowly.
 */
const codeFieldStep = (): AutofillStep => {
  const anyOf = (selectors: readonly string[]) => selectors.join(", ");
  const namedBy = (words: readonly string[]) =>
    anyOf(words.flatMap((word) => [`[name*="${word}" i]`, `[id*="${word}" i]`]));
  const marked = 'input[autocomplete="one-time-code" i]';
  const shortNumeric = [
    `:is(${anyOf(['[inputmode="numeric" i]', '[type="number" i]', '[type="tel" i]'])})`,
    `:is(${anyOf([4, 5, 6, 7, 8].map((length) => `[maxlength="${length}"]`))})`,
  ].join("");
  const codeLike = [
    `input:is(${anyOf([":not([type])", '[type="text" i]', '[type="number" i]', '[type="tel" i]'])})`,
    `:is(${namedBy(oneTimeCodeWords)}, :is(${namedBy(codeWords)})${shortNumeric})`,
    `:not(${anyOf([
      namedBy(otherWords),
      ...otherWords.map((word) => `[autocomplete*="${word}" i]`),
      '[autocomplete^="tel" i]',
      '[autocomplete^="cc-" i]',
    ])})`,
  ].join("");
  // A page with a marked field matches only that, so a row of boxes whose first is marked and
  // whose ids name a code still matches that one box, as before.
  const unmarkedPage = `:root:not(:has(${marked}))`;
  const submit = `:is(${anyOf(['button[type="submit" i]', 'input[type="submit" i]', "button:not([type])"])})`;
  return {
    fields: [{ selector: `${marked}, ${unmarkedPage} ${codeLike}`, slot: "code" }],
    submit: `form:has(${marked}) ${submit}, ${unmarkedPage} form:has(${codeLike}) ${submit}`,
  };
};
export const unrecordedCodeStep = codeFieldStep();

/**
 * The screen an unrecorded code field sits on: its page's origin and path, and the field's own id,
 * name and label. Only this screen showing again is a refused code; any other is a new screen.
 */
export const codeScreenOf = (inspection: AutofillInspection) => {
  const field = inspection.screen.fields[0];
  return JSON.stringify([
    inspection.page,
    field?.id ?? null,
    field?.name ?? null,
    field?.label ?? null,
  ]);
};

/**
 * Words like `otherWords` that count only as a word of their own, split at a non-letter or a
 * lower-to-upper case change, as a substring of a code box's name would match too: `pin` names
 * `pinCode`, `card_pin` and `PIN`, never `otpInput` or `spinner`.
 */
const wholeOtherWords = ["pin"];
const wordsOf = (value: string) =>
  value.split(/[^A-Za-z]+|(?<=[a-z])(?=[A-Z])/).map((word) => word.toLowerCase());

/**
 * Whether a field not marked as a one-time code has `wholeOtherWords` in its name, id or
 * autocomplete.
 */
export const namesWholeOtherWord = (
  field: Pick<AutofillInspection["screen"]["fields"][number], "name" | "id" | "autocomplete">,
) =>
  field.autocomplete?.toLowerCase() !== "one-time-code" &&
  [field.name, field.id, field.autocomplete].some(
    (value) => value !== null && wordsOf(value).some((word) => wholeOtherWords.includes(word)),
  );

/**
 * `step`'s inspection, where a field the selector matched that holds `wholeOtherWords` is not one,
 * so it reads as none found.
 */
const inspectCodeStep = <E>(hooks: Pick<AutofillHooks<E>, "inspect">, step: AutofillStep) =>
  Effect.map(hooks.inspect(step), (inspected): AutofillRefusal | AutofillInspection => {
    const field = "outcome" in inspected ? undefined : inspected.screen.fields[0];
    return field !== undefined && namesWholeOtherWord(field)
      ? { outcome: "refused", reason: "not_found" }
      : inspected;
  });

/**
 * Looks for the code field and its form's submit (`unrecordedCodeStep`): a field the selector
 * matched that holds `wholeOtherWords` is not one, so it reads as none found.
 */
export const findCodeField = <E>(hooks: Pick<AutofillHooks<E>, "inspect">) =>
  inspectCodeStep(hooks, unrecordedCodeStep);

/**
 * The same code field alone, for a screen that has it in no form with a submit, as a code field
 * that sends itself once it holds the whole code does: the step has no submit, so the fill types
 * the code, clicks nothing and counts the page's own send (`page`).
 */
export const selfSendingCodeStep: AutofillStep = { fields: unrecordedCodeStep.fields };

/** A code screen the look found: the step that takes it, and that step's inspection. */
export interface FoundCodeScreen {
  readonly step: AutofillStep;
  readonly inspection: AutofillInspection;
}

const codeScreen = (step: AutofillStep, inspection: AutofillInspection): FoundCodeScreen => ({
  step,
  inspection,
});

/**
 * Looks for a code screen the recipe never recorded: the code field and its form's submit
 * (`findCodeField`), else, when the field shows with no such submit, the field alone
 * (`selfSendingCodeStep`), matched by the same selector and the same `wholeOtherWords` rule.
 */
export const findCodeScreen = <E>(hooks: Pick<AutofillHooks<E>, "inspect">) =>
  Effect.gen(function* () {
    const withSubmit = yield* findCodeField(hooks);
    if (!("outcome" in withSubmit)) return codeScreen(unrecordedCodeStep, withSubmit);
    if (withSubmit.reason !== "not_found" || withSubmit.target !== "submit") return withSubmit;
    const alone = yield* inspectCodeStep(hooks, selfSendingCodeStep);
    return "outcome" in alone ? alone : codeScreen(selfSendingCodeStep, alone);
  });

/**
 * Whether the inspected code screen is on a sign-in origin: a recorded screen's (`recorded`), or
 * one off the site that the browser trusts for this tool's sign-in, as the inspection judged it,
 * such as one the tool's owner approved. A page on the site's own registrable domain
 * that no recorded screen ran on is never one, so an account page's field is never taken for one,
 * except on a site whose sign-in shares the app's origin.
 */
export const onSignInOrigin = (
  recorded: ReadonlySet<string>,
  inspection: Pick<AutofillInspection, "page" | "siteOrigin" | "authenticationOrigins">,
) => {
  const page = URL.parse(inspection.page);
  if (page === null) return false;
  return (
    recorded.has(page.origin) ||
    (inspection.authenticationOrigins.includes(page.origin) &&
      !sameSite(inspection.siteOrigin, page))
  );
};
