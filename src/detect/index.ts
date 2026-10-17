// All detectors. `detectAll` returns the classes that fired (count > 0). Pure: same text and config, same answer.
import { detectAddresses } from "./address.ts";
import { detectCards } from "./card.ts";
import { detectEmails } from "./email.ts";
import { DEFAULT_GOV_COUNTRIES, detectGovIds } from "./govid.ts";
import { detectIbans } from "./iban.ts";
import { mapBack, normalize } from "./normalize.ts";
import { detectPhones } from "./phone.ts";
import { detectSecrets } from "./secret.ts";
import { detectSpecial } from "./special.ts";
import type { Detection } from "./types.ts";

export interface DetectConfig {
  /** countries whose government ids are looked for (default SK, CZ, DE, US) */
  govCountries?: readonly string[];
}

/**
 * All detectors, on a NORMALISED copy of the text (NFKC, format characters dropped, see normalize.ts), with every span mapped
 * back to the original offsets. Secrets are looked for on their own copy that also folds Cyrillic/Greek look-alikes.
 */
export function detectAll(text: string, cfg: DetectConfig = {}): Detection[] {
  const base = normalize(text);
  const t = base.text;
  const back = (d: Detection): Detection => (base.identity ? d : { class: d.class, spans: mapBack(d.spans, base), count: d.count });
  const all = [
    detectSecrets(text),
    back(detectEmails(t)),
    back(detectPhones(t)),
    back(detectIbans(t)),
    back(detectCards(t)),
    back(detectGovIds(t, cfg.govCountries ?? DEFAULT_GOV_COUNTRIES)),
    back(detectAddresses(t)),
    back(detectSpecial(t)),
  ];
  return all.filter((d) => d.count > 0);
}

export { LABELS, mergeSpans, PRIORITY, redactText } from "./redact.ts";
export type { DetectClass, Detection, PiiClass, Span } from "./types.ts";
export { isPiiClass, PII_CLASSES } from "./types.ts";
