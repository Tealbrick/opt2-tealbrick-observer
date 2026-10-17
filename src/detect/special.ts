// Special-category words (GDPR art. 9): health, religion, trade union, sexuality, ethnicity — per-language word lists
// (EN, SK, DE first), matched on whole words, Unicode-aware, case-insensitive (see words.ts for the entry syntax).
import { type Detection, detection } from "./types.ts";
import { buildWordMatcher } from "./words.ts";

export type SpecialCategory = "health" | "religion" | "union" | "sexuality" | "ethnicity";
export type Lang = "en" | "sk" | "de";

export const SPECIAL_WORDS: Readonly<Record<Lang, Readonly<Record<SpecialCategory, readonly string[]>>>> = {
  en: {
    health: ["diagnosis", "diagnosed", "cancer", "chemotherapy", "diabetes", "diabetic", "hiv", "depression", "depressed", "anxiety disorder", "pregnant", "pregnancy", "miscarriage", "surgery", "therapy", "therapist", "psychiatric", "psychiatrist", "medication", "prescription", "disability", "disabled", "sick leave", "illness", "epilepsy", "asthma", "dementia", "alzheimer*", "burnout", "rehab", "addiction", "medical condition"],
    religion: ["muslim*", "christianity", "jewish", "judaism", "catholic*", "protestant*", "orthodox church", "atheist*", "buddhist*", "buddhism", "hindu*", "sikh*", "religion", "religious", "mosque", "synagogue", "islam", "islamic", "baptism"],
    union: ["trade union*", "labour union*", "labor union*", "union member*", "union rep", "shop steward", "collective bargaining"],
    sexuality: ["gay", "lesbian", "bisexual", "transgender", "homosexual*", "heterosexual*", "queer", "sexual orientation", "asexual", "coming out"],
    ethnicity: ["ethnicity", "ethnic origin", "ethnic minority", "racial origin", "romani"],
  },
  sk: {
    health: ["diagnóza", "diagnóz*", "diagnostikovan*", "rakovin*", "chemoterapi*", "cukrovk*", "diabet*", "hiv", "depresi*", "úzkost*", "tehotn*", "tehoten*", "potrat*", "terapi*", "psychiatr*", "liek*", "lieky", "zdravotn* postihnut*", "práceneschopn*", "choroba", "chorob*", "epilepsi*", "astm*", "demenci*", "vyhorenie"],
    religion: ["moslim*", "kresťan*", "židov*", "judaizmus", "katolí*", "protestant*", "ateist*", "budhist*", "budhizmus", "hinduist*", "náboženstv*", "náboženský", "mešit*", "synagóg*", "islam*", "krst*"],
    union: ["odbory", "odborov*", "odborár*", "kolektívne vyjednávanie"],
    sexuality: ["homosexuál*", "heterosexuál*", "gej", "gejov*", "lesb*", "bisexuál*", "transrodov*", "transgender*", "queer", "sexuálna orientácia", "sexuálnej orientácie", "sexuálnu orientáciu"],
    ethnicity: ["etnick*", "etnicit*", "rómsk*", "rasov*", "národnosť", "národnost*"],
  },
  de: {
    health: ["diagnose*", "krebs", "chemotherapie", "diabetes", "diabetiker*", "hiv", "depression*", "angststörung*", "schwanger*", "fehlgeburt", "therapie*", "psychiater*", "medikament*", "behinderung*", "krankschreibung*", "krankheit*", "epilepsie", "asthma", "demenz", "alzheimer*", "burnout", "suchtkrank*"],
    religion: ["muslim*", "christlich*", "christentum", "jüdisch*", "judentum", "katholisch*", "evangelisch*", "protestantisch*", "atheist*", "buddhist*", "buddhismus", "hindu*", "sikh*", "religion*", "religiös*", "moschee*", "synagoge*", "islam*", "taufe", "glaubens*"],
    union: ["gewerkschaft*", "betriebsrat", "tarifverhandlung*"],
    sexuality: ["schwul*", "lesbisch*", "bisexuell*", "homosexuell*", "heterosexuell*", "transgender*", "queer", "sexuelle orientierung", "transsexuell*"],
    ethnicity: ["ethnisch*", "ethnizität", "rasse*", "rassisch*", "roma", "sinti"],
  },
};

const MATCH = buildWordMatcher(Object.values(SPECIAL_WORDS).flatMap((lang) => Object.values(lang).flat()));

export function detectSpecial(text: string): Detection {
  return detection("special", MATCH(text));
}
