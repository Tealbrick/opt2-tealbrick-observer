// Postal addresses: LOW confidence, so only a street WITH a house number counts (EN "10 Downing Street", SK/CZ "ul. Hlavná 12/3" or
// "Hlavná 12, 811 01 Bratislava", DE "Musterstraße 5a"); a following postal code + city ("811 01 Bratislava", "10115 Berlin") is taken
// into the span. A bare postal code, a city, "Main Street" without a number or an order number is not an address.
// Every pattern is linear: each repeated class has an upper bound and is followed by a fixed delimiter.
import { type Detection, detection, mergeOverlaps, type Span } from "./types.ts";

const EN = /(?<![\p{L}\p{N}])\d{1,5}(?:[-/]\d{1,5})?[ \t]+(?:\p{Lu}[\p{L}'.-]{0,30}[ \t]+){1,3}(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr|Boulevard|Blvd|Court|Ct|Way|Square|Sq|Place|Pl)(?![\p{L}\p{N}])\.?/gu;
const DE = /(?<![\p{L}\p{N}])\p{Lu}[\p{L}-]{0,40}(?:straße|strasse|str\.|weg|platz|allee|gasse|ring|damm|ufer)[ \t]{0,2}\d{1,4}[ \t]?[a-z]?(?![\p{L}\p{N}])/gu;
const SK_CZ = /(?<![\p{L}\p{N}])(?:ul\.|ulica|ulice|nám\.|námestie|náměstí|tr\.|trieda|třída)[ \t]{0,2}\p{Lu}[\p{L}.\- ]{1,30}?[ \t]+\d{1,4}(?:\/(?:\d{1,4}|[A-Za-z]))?[A-Za-z]?(?![\p{L}\p{N}])/gu;
// Slovak / Czech street names without "ul.": an adjective-like name (Hlavná, Štúrova, Mlynská, Zahradní) or "<Name> ulica", then the house number
const SK_PLAIN = /(?<![\p{L}\p{N}])\p{Lu}[\p{L}]{2,24}(?:ová|ská|ská|ná|ého|ej|ní|ická|ova|ova)(?: ulica| ulice)?[ \t]\d{1,4}(?:\/(?:\d{1,4}|[A-Za-z]))?[A-Za-z]?(?![\p{L}\p{N}])/gu;
const SK_ULICA = /(?<![\p{L}\p{N}])\p{Lu}[\p{L}]{2,24} (?:ulica|ulice)[ \t]\d{1,4}(?:\/(?:\d{1,4}|[A-Za-z]))?[A-Za-z]?(?![\p{L}\p{N}])/gu;
const POSTAL_CITY = /^,?[ \t]*(?:\d{3} ?\d{2}|\d{5})[ \t]+\p{Lu}\p{L}+/u;

export function detectAddresses(text: string): Detection {
  const spans: Span[] = [];
  if (!/\d/.test(text)) return detection("address", spans);
  for (const re of [EN, DE, SK_CZ, SK_PLAIN, SK_ULICA]) {
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      let end = start + m[0].length;
      const tail = POSTAL_CITY.exec(text.slice(end, end + 60));
      if (tail) end += tail[0].length;
      spans.push({ start, end });
    }
  }
  return detection("address", mergeOverlaps(spans));
}
