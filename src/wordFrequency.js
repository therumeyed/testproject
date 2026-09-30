// Powers the dashboard's word cloud: the words used most often across
// mention titles/snippets, with common English filler AND the airport's own
// recurring nouns (melbourne, airport, parking, train, ...) excluded --
// those are already covered by the category breakdown, so the word cloud's
// job is to surface the descriptive/sentiment-carrying words that aren't
// (poor, rude, confusing, expensive, helpful, ...).

const GENERIC_STOPWORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by',
  'can', 'cant', 'could', 'couldnt',
  'did', 'didnt', 'do', 'does', 'doesnt', 'doing', 'dont', 'down', 'during',
  'each', 'few', 'for', 'from', 'further',
  'had', 'hadnt', 'has', 'hasnt', 'have', 'havent', 'having', 'he', 'her', 'here', 'hers', 'herself',
  'him', 'himself', 'his', 'how',
  'i', 'if', 'in', 'into', 'is', 'isnt', 'it', 'its', 'itself',
  'just', 'll',
  'me', 'more', 'most', 'my', 'myself',
  'no', 'nor', 'not', 'now',
  'of', 'off', 'on', 'once', 'only', 'or', 'other', 'our', 'ours', 'ourselves', 'out', 'over', 'own',
  're',
  'same', 'she', 'should', 'shouldnt', 'so', 'some', 'such',
  'than', 'that', 'thats', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these',
  'they', 'this', 'those', 'through', 'to', 'too',
  'under', 'until', 'up',
  've', 'very',
  'was', 'wasnt', 'we', 'were', 'werent', 'what', 'when', 'where', 'which', 'while', 'who', 'whom',
  'why', 'will', 'with', 'wont', 'would', 'wouldnt',
  'you', 'your', 'yours', 'yourself', 'yourselves',
  'im', 'ive', 'id', 'youre', 'youve', 'theyre', 'weve', 'hes', 'shes', 'wasn', 'aren', 'doesn', 'didn',
  'read', 'more', 'also', 'said', 'says', 'seemed', 'seem', 'one', 'two', 'three', 'first', 'today',
  'us', 'new', 'news', 'via', 'com', 'www', 'http', 'https', 'amp', 'experience', 'coverage', 'throughout',
  // Wire/press-style boilerplate that otherwise dominates word counts once
  // general news coverage (not customer reviews) is in the mix.
  'travel', 'traveling', 'travelling', 'check', 'time', 'available', 'information', 'jobs', 'city',
  'need', 'free', 'make', 'current', 'morning', 'changes', 'photo', 'follow', 'book', 'manager',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october',
  'november', 'december'
]);

// The airport's own recurring nouns -- these dominate raw word counts
// without saying anything the category breakdown doesn't already show.
const DOMAIN_STOPWORDS = new Set([
  'melbourne', 'airport', 'airports', 'melbourneairport', 'tullamarine', 'mel', 'australia', 'australian', 'victoria',
  'flight', 'flights', 'plane', 'planes', 'terminal', 'terminals',
  'car', 'cars', 'park', 'parks', 'parking', 'parked',
  'train', 'trains', 'bus', 'buses', 'skybus',
  'taxi', 'taxis', 'uber', 'didi', 'rideshare', 'ride',
  'drop', 'off', 'pickup', 'pick', 'drive', 'driving', 'road',
  'arrival', 'arrivals', 'departure', 'departures', 'domestic', 'international',
  // Airline/manufacturer brand names and generic aviation-industry nouns --
  // topical (which airline/what kind of aircraft), not sentiment-carrying,
  // and otherwise very common in general aviation news coverage.
  'airline', 'airlines', 'airways', 'aviation', 'aircraft', 'runway', 'boeing', 'airbus',
  'qantas', 'jetstar', 'virgin', 'emirates', 'transfer', 'transfers', 'passenger', 'passengers'
]);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .split(/[^a-z]+/)
    .filter(Boolean);
}

function computeWordFrequencies(texts, { limit = 40, minLength = 4 } = {}) {
  const counts = new Map();
  for (const text of texts) {
    for (const word of tokenize(text)) {
      if (word.length < minLength) continue;
      if (GENERIC_STOPWORDS.has(word) || DOMAIN_STOPWORDS.has(word)) continue;
      counts.set(word, (counts.get(word) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
    .slice(0, limit);
}

module.exports = { computeWordFrequencies, tokenize, GENERIC_STOPWORDS, DOMAIN_STOPWORDS };
