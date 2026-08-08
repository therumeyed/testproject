function matchesPhrase(text, phrase) {
  return (text || '').toLowerCase().includes(String(phrase).toLowerCase());
}

module.exports = { matchesPhrase };
