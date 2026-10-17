// All detectors. `detectAll` returns the classes that fired (count > 0). Pure: same text and config, same answer.
import { detectAddresses } from "./address.ts";
import { detectCards } from "./card.ts";
import { detectEmails } from "./email.ts";
import { DEFAULT_GOV_COUNTRIES, detectGovIds } from "./govid.ts";
import { detectIbans } from "./iban.ts";
import { detectPhones } from "./phone.ts";
import { detectSecrets } from "./secret.ts";
import { detectSpecial } from "./special.ts";
import type { Detection } from "./types.ts";

export interface DetectConfig {
  /** countries whose government ids are looked for (default SK, CZ, DE, US) */
  govCountries?: readonly string[];
}

export function detectAll(text: string, cfg: DetectConfig = {}): Detection[] {
  const all = [
    detectSecrets(text),
    detectEmails(text),
    detectPhones(text),
    detectIbans(text),
    detectCards(text),
    detectGovIds(text, cfg.govCountries ?? DEFAULT_GOV_COUNTRIES),
    detectAddresses(text),
    detectSpecial(text),
  ];
  return all.filter((d) => d.count > 0);
}

export { LABELS, mergeSpans, PRIORITY, redactText } from "./redact.ts";
export type { DetectClass, Detection, PiiClass, Span } from "./types.ts";
export { isPiiClass, PII_CLASSES } from "./types.ts";
