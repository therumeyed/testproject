const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { renderUrgentAlert, renderDailyDigest } = require('../src/emailTemplates');

const sample = {
  source: 'google_reviews',
  title: 'Melbourne Airport — 1★',
  snippet: 'Parking fees are expensive.',
  url: 'https://example.com/review',
  severity: 'high',
  category: 'parking',
  reason: 'Complains about parking cost.'
};

describe('renderUrgentAlert', () => {
  test('includes the mention title, reason, and a link to the dashboard', () => {
    const { subject, html } = renderUrgentAlert([sample]);
    assert.match(subject, /1 urgent negative mention/);
    assert.match(html, /Melbourne Airport — 1★/);
    assert.match(html, /Complains about parking cost\./);
    assert.match(html, /href="https:\/\/example\.com\/review"/);
    assert.match(html, /melairmentions\.brandassistant\.app/);
  });

  test('pluralizes correctly for more than one mention', () => {
    const { subject, html } = renderUrgentAlert([sample, sample]);
    assert.match(subject, /2 urgent negative mentions/);
    assert.match(html, /2 high-severity negative mentions found/);
  });

  test('escapes HTML in untrusted mention content (title/snippet/reason)', () => {
    const malicious = { ...sample, title: '<img src=x onerror=alert(1)>', snippet: '<script>evil()</script>', reason: '"><b>injected</b>' };
    const { html } = renderUrgentAlert([malicious]);
    assert.ok(!html.includes('<img src=x'));
    assert.ok(!html.includes('<script>evil()</script>'));
    assert.ok(!html.includes('"><b>injected</b>'));
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });
});

describe('renderDailyDigest', () => {
  test('renders every mention passed in', () => {
    const { subject, html } = renderDailyDigest([sample, { ...sample, title: 'Second mention' }]);
    assert.match(subject, /2 found/);
    assert.match(html, /Melbourne Airport — 1★/);
    assert.match(html, /Second mention/);
  });

  test('shows a friendly empty state instead of an empty list when there is nothing to report', () => {
    const { subject, html } = renderDailyDigest([]);
    assert.match(subject, /0 found/);
    assert.match(html, /All quiet today/);
  });
});
