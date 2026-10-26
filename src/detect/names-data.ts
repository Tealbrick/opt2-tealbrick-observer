// Given names and cue words for the person-name detector (name.ts). Lower case; diacritics are kept here and folded at load.
// Provenance (C190 Observer, 0.1.1): a hand-written list of frequent given names, compiled by the Observer lead from public
// facts, not copied from any file: the US Social Security Administration baby-name statistics (a US government work, public
// domain) for EN; the Slovak and Czech name-day calendars (public facts) for SK/CZ; common German given names for DE. Names are
// facts, so the list carries no licence. Add names freely; keep words that are also common nouns or adjectives in AMBIGUOUS.

export const GIVEN_EN: readonly string[] = [
  "james", "john", "robert", "michael", "william", "david", "richard", "joseph", "thomas", "charles", "christopher", "daniel",
  "matthew", "anthony", "mark", "donald", "steven", "paul", "andrew", "joshua", "kenneth", "kevin", "brian", "george", "timothy",
  "ronald", "edward", "jason", "jeffrey", "ryan", "jacob", "gary", "nicholas", "eric", "jonathan", "stephen", "larry", "justin",
  "scott", "brandon", "benjamin", "samuel", "gregory", "alexander", "frank", "patrick", "raymond", "jack", "dennis", "jerry",
  "tyler", "aaron", "jose", "adam", "nathan", "henry", "douglas", "zachary", "peter", "kyle", "ethan", "walter", "noah",
  "jeremy", "christian", "keith", "roger", "terry", "gerald", "harold", "sean", "austin", "carl", "arthur", "lawrence", "dylan",
  "jesse", "jordan", "bryan", "billy", "joe", "bruce", "gabriel", "logan", "albert", "willie", "alan", "juan", "wayne",
  "elijah", "randy", "roy", "vincent", "ralph", "eugene", "russell", "bobby", "mason", "philip", "louis", "liam", "oliver",
  "lucas", "alex", "chris", "mike", "tom", "tim", "nick", "steve", "dave", "bob", "jim", "sam", "matt", "tony", "greg", "ben",
  "max", "will", "bill", "dan",
  "mary", "patricia", "jennifer", "linda", "elizabeth", "barbara", "susan", "jessica", "sarah", "karen", "lisa", "nancy",
  "betty", "margaret", "sandra", "ashley", "kimberly", "emily", "donna", "michelle", "carol", "amanda", "dorothy", "melissa",
  "deborah", "stephanie", "rebecca", "sharon", "laura", "cynthia", "kathleen", "amy", "angela", "shirley", "anna", "brenda",
  "pamela", "emma", "nicole", "helen", "samantha", "katherine", "christine", "debra", "rachel", "carolyn", "janet",
  "catherine", "maria", "heather", "diane", "ruth", "julie", "olivia", "joyce", "virginia", "victoria", "kelly", "lauren",
  "christina", "joan", "evelyn", "judith", "megan", "andrea", "cheryl", "hannah", "jacqueline", "martha", "gloria", "teresa",
  "ann", "sara", "madison", "frances", "kathryn", "janice", "jean", "abigail", "alice", "judy", "sophia", "julia", "isabella",
  "charlotte", "amelia", "mia", "harper", "ella", "chloe", "natalie", "zoe", "lily", "grace", "rose", "kate", "jane", "beth",
  "sue", "eve", "june", "may", "april", "hope", "faith", "joy",
];

export const GIVEN_SK_CZ: readonly string[] = [
  "ján", "jan", "peter", "pavol", "pavel", "martin", "michal", "tomáš", "jozef", "josef", "štefan", "lukáš", "marek", "juraj",
  "jiří", "miroslav", "milan", "vladimír", "ladislav", "marián", "róbert", "roman", "richard", "igor", "ivan", "jakub", "matej",
  "matěj", "dávid", "filip", "adam", "samuel", "šimon", "daniel", "patrik", "oliver", "radoslav", "radek", "rastislav",
  "branislav", "stanislav", "dušan", "ľubomír", "lubomír", "zdeněk", "jaroslav", "karel", "karol", "václav", "antonín",
  "františek", "ondřej", "ondrej", "vojtěch", "vojtech", "viktor", "tibor", "norbert", "erik", "dominik", "kristián",
  "sebastián", "alexander", "andrej", "boris", "bohumil", "bohuslav", "emil", "eduard", "ferdinand", "gabriel", "henrich",
  "imrich", "jaromír", "kamil", "kornel", "ľudovít", "luboš", "ľuboš", "maroš", "matúš", "miloš", "oskar", "otakar",
  "přemysl", "radim", "rudolf", "svätopluk", "vít", "vladislav", "zoltán", "alojz",
  "mária", "marie", "anna", "jana", "eva", "zuzana", "katarína", "kateřina", "lucia", "lucie", "martina", "veronika", "monika",
  "ivana", "jarmila", "helena", "alžbeta", "alžběta", "dana", "daniela", "petra", "lenka", "simona", "michaela", "barbora",
  "kristína", "kristýna", "natália", "nikola", "tereza", "terézia", "adriana", "andrea", "alena", "beáta", "božena", "dagmar",
  "denisa", "dominika", "emília", "gabriela", "hana", "iveta", "ingrid", "jaroslava", "jitka", "jozefína", "klára", "kamila",
  "laura", "ľubica", "ľudmila", "ludmila", "magdaléna", "marcela", "markéta", "miroslava", "nina", "olga", "renáta", "silvia",
  "sofia", "soňa", "stanislava", "svetlana", "šárka", "tatiana", "vanesa", "vladimíra", "zdenka", "zora", "viera", "věra",
  "mila", "iva", "ema", "eliška", "karolína", "valentína", "sára", "ela",
];

export const GIVEN_DE: readonly string[] = [
  "thomas", "michael", "andreas", "stefan", "peter", "christian", "frank", "markus", "wolfgang", "klaus", "jürgen", "uwe",
  "bernd", "ralf", "matthias", "alexander", "martin", "sebastian", "daniel", "tobias", "florian", "jan", "lukas", "leon",
  "felix", "jonas", "paul", "maximilian", "lars", "sven", "jens", "jörg", "dieter", "günter", "gerhard", "hans", "heinz",
  "helmut", "horst", "karl", "manfred", "rainer", "werner", "dirk", "holger", "torsten", "kai", "tim", "niklas", "moritz",
  "julian", "fabian", "benedikt", "johannes", "simon", "philipp", "david", "finn", "elias", "emil", "oskar", "ole", "mats",
  "henrik", "friedrich", "wilhelm", "ernst", "otto", "kurt", "rolf",
  "erika", "ursula", "sabine", "petra", "monika", "andrea", "claudia", "susanne", "nicole", "stefanie", "julia", "katharina",
  "anja", "birgit", "karin", "renate", "gabriele", "ingrid", "heike", "silke", "sandra", "melanie", "christina", "kathrin",
  "nina", "laura", "lena", "lea", "hannah", "sophie", "mia", "emma", "marie", "anna", "lina", "clara", "leonie", "johanna",
  "charlotte", "greta", "frieda", "ida", "ella", "maja", "luisa", "elke", "gisela", "helga", "brigitte", "inge", "jutta",
  "martina", "tanja", "yvonne", "doris", "bärbel", "ute",
];

/** Given names that are also common words (or months, cities): they count only with a surname after them or a cue word. */
export const AMBIGUOUS: readonly string[] = [
  "will", "bill", "mark", "max", "ben", "dan", "jan", "milan", "may", "june", "april", "hope", "faith", "joy", "grace", "rose",
  "lily", "sue", "eve", "frank", "ernst", "austin", "jordan", "mason", "christian", "virginia", "randy", "carol", "roman",
  "sofia", "viera", "věra", "mila", "zora", "kai", "mats", "victoria", "charlotte", "madison",
];

/** Words before a name: courtesy titles (the name after them may be any capitalised word, also a surname alone). */
export const TITLES: readonly string[] = ["mr", "mrs", "ms", "miss", "mx", "dr", "prof", "sir", "madam", "pán", "pan", "pani", "paní", "slečna", "herr", "frau"];

/** Greetings: a capitalised word right after one is read as a name (low confidence). */
export const GREETINGS: readonly string[] = ["hi", "hello", "hey", "dear", "ahoj", "čau", "nazdar", "milý", "milá", "milí", "vážený", "vážená", "hallo", "liebe", "lieber", "servus", "moin", "geehrte", "geehrter"];

/** Sign-offs: a short capitalised line after one (or after its comma) is read as the writer's name (low confidence). */
export const CLOSINGS: readonly string[] = [
  "thanks", "thank you", "many thanks", "regards", "best regards", "kind regards", "warm regards", "best", "cheers", "best wishes",
  "sincerely", "yours sincerely", "yours", "s pozdravom", "s pozdravem", "pozdravujem", "ďakujem", "ďakujeme", "díky", "děkuji",
  "vďaka", "danke", "vielen dank", "viele grüße", "beste grüße", "liebe grüße", "herzliche grüße", "gruß", "lg", "mfg",
  "mit freundlichen grüßen",
];

/** Capitalised words that are never a name: they stop a surname run and are never read as a name after a cue. */
export const NOT_NAMES: readonly string[] = [
  "i", "the", "a", "an", "and", "or", "but", "if", "on", "in", "at", "to", "of", "for", "from", "with", "by", "this", "that",
  "please", "thanks", "thank", "team", "all", "everyone", "everybody", "there", "folks", "guys", "friends", "colleagues",
  "customer", "customers", "support", "sir", "madam", "world", "grüße", "gruß", "grüsse", "gruss", "regards", "wishes", "dank",
  "kolleginnen", "dein", "deine", "euer", "eure", "ihr", "ihre", "your", "our", "váš", "vaša", "vaše", "kollegen", "zusammen", "kolegovia", "kolegyne", "kolegové", "všetci",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "january", "february", "march", "july",
  "september", "october", "november", "december", "pondelok", "utorok", "streda", "štvrtok", "piatok", "sobota", "nedeľa",
  "pondělí", "úterý", "čtvrtek", "pátek", "neděle", "montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag",
  "sonntag", "januar", "februar", "märz", "juli", "oktober", "dezember", "inc", "ltd", "llc", "gmbh", "ag", "sro", "as",
  "und", "oder", "der", "die", "das", "ein", "eine", "aj", "alebo", "ale", "je", "sa",
];
