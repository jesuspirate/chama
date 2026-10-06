// i18n namespace "picker" — GlobeCountryPicker (country pick + detail landing).
// NOTE the Before/After pairs: a bold styled span sits mid-sentence in the JSX,
// so the sentence is split around it. Translators translate BOTH halves as one
// sentence (word order may move words across the boundary if the target
// language needs it — keep the {param} placeholders intact).
export const picker: Record<string, string> = {
  "picker.allCountries": "All countries",
  "picker.availableBodyAfter":
    "— backed by Chama's global arbiters. Your own local Chama is coming; switch to it the moment it launches.",
  "picker.availableBodyBefore": "Trade {name}'s sats now as",
  "picker.availableNowBadge": "✓ Available now",
  "picker.bondedNote": "· {count} bonded",
  "picker.chooseYourChama": "Choose your Chama",
  "picker.comingSoonBadge": "○ Coming soon",
  "picker.comingSoonBodyAfter":
    "on Chama's global federation, backed by the cabinet's arbiters.",
  "picker.comingSoonBodyBefore":
    "A local Chama in {name} is coming. You can start trading today as",
  "picker.continueAs": "Continue as {flag} {name} · {currency} →",
  "picker.everyCountry": "Every country",
  "picker.findCountry":
    "Find your country — your currency and local payment methods come with it. You can change it anytime.",
  "picker.matchMany": "{count} matches",
  "picker.matchOne": "1 match",
  "picker.noMatch":
    "No country matches “{query}”. Check the spelling and try again.",
  "picker.searchAria": "Search countries",
  "picker.searchPlaceholder": "Search 190+ countries…",
  "picker.subAvailableNow": "{currency} · available now",
  "picker.subChamas": "{currency} · {count} Chamas",
  "picker.subComingSoon": "{currency} · coming soon",
  "picker.subLocalChama": "{currency} · local Chama",
  "picker.whereHome": "Where's home?",
  "picker.yourCountry": "Your country",
  "picker.showAll": "Show all {count} countries",
};
