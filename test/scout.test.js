const { test } = require("node:test");
const assert = require("node:assert");
const S = require("../scout.js");

const cfg = { ...S.DEFAULTS, brands: ["Carhartt", "Nike"], maxPrice: 60, minProfit: 20, minRoi: 0.6 };

const EMAIL = `
<html><body>
  <tr><td>
    <img src="https://media-photos.depop.com/b1/abc/P0.jpg" alt="Carhartt Detroit Jacket Vintage">
    <p>Brand: Carhartt</p><p>Size: L</p><p>Condition: Used - Good</p>
    <p>Price $45.00</p><p>Shipping $6.00</p>
    <a href="https://www.depop.com/products/seller-carhartt-detroit-jacket/">View item</a>
  </td></tr>
  <tr><td>
    <img src="https://media-photos.depop.com/b1/def/P0.jpg" alt="Nike Tee">
    <p>Brand: Nike</p><p>Price $120.00</p>
    <a href="https://www.depop.com/products/seller-nike-tee/">View item</a>
  </td></tr>
  <a href="https://evil.example.com/products/not-depop/">tracker</a>
</body></html>`;

test("parses listings and ignores non-Depop links", () => {
  const l = S.parseDepopEmail(EMAIL);
  assert.equal(l.length, 2);
  assert.equal(l[0].id, "seller-carhartt-detroit-jacket");
  assert.ok(l[0].url.startsWith("https://www.depop.com/products/"));
  assert.ok(!JSON.stringify(l).includes("evil.example.com"));
});

test("extracts price, shipping, size, brand", () => {
  const [a] = S.parseDepopEmail(EMAIL);
  assert.equal(a.price, 45);
  assert.equal(a.shipping, 6);
  assert.equal(a.size, "L");
  assert.equal(a.brand, "Carhartt");
});

test("deduplicates repeated links in one email", () => {
  const dup = EMAIL + EMAIL;
  assert.equal(S.parseDepopEmail(dup).length, 2);
});

test("sanitises html and scripts out of text fields", () => {
  const nasty = `<a href="https://www.depop.com/products/x-y-z/">x</a>
    <img src="https://m.depop.com/a.jpg" alt="<script>alert(1)</script>Jacket">`;
  const [l] = S.parseDepopEmail(nasty);
  assert.ok(!/<script>/i.test(JSON.stringify(l)), "no raw script tags survive");
});

test("only depop.com senders are accepted", () => {
  assert.ok(S.isDepopSender("Depop <no-reply@depop.com>"));
  assert.ok(S.isDepopSender("notifications@mail.depop.com"));
  assert.ok(!S.isDepopSender("no-reply@depop.com.attacker.net"));
  assert.ok(!S.isDepopSender("someone@gmail.com"));
});

test("criteria rejects over-max-price and off-brand", () => {
  const [carhartt, nike] = S.parseDepopEmail(EMAIL);
  assert.equal(S.matchesCriteria(carhartt, cfg).ok, true);
  const r = S.matchesCriteria(nike, cfg);
  assert.equal(r.ok, false);
  assert.ok(r.why.some(w => /max price/.test(w)));
});

test("no comps means REVIEW, never BUY, and no invented numbers", async () => {
  const [a] = S.parseDepopEmail(EMAIL);
  const out = await S.analyse(a, cfg);
  assert.equal(out.rating, "REVIEW");
  assert.equal(out.net, null);
  assert.equal(out.resaleLow, null);
  assert.equal(out.confidence, "low");
});

test("with strong comps a genuine winner rates BUY", async () => {
  const [a] = S.parseDepopEmail(EMAIL);
  const compsProvider = async () => ({
    source: "test", demand: "high",
    sales: [140, 145, 150, 150, 155, 160, 165, 170, 175, 180, 185, 190],
  });
  const out = await S.analyse(a, cfg, { compsProvider });
  assert.equal(out.rating, "BUY");
  assert.equal(out.acquisition, 51);
  assert.ok(out.net > 20 && out.roi > 0.6, `net=${out.net} roi=${out.roi}`);
  assert.equal(out.confidence, "high");
});

test("estimates price off the bottom quartile, not the top", async () => {
  const [a] = S.parseDepopEmail(EMAIL);
  const sales = [100, 100, 100, 100, 100, 100, 300, 300, 300, 300, 300, 300];
  const out = await S.analyse(a, cfg, { compsProvider: async () => ({ sales, source: "test" }) });
  assert.ok(out.resaleLow <= 150, `conservative low, got ${out.resaleLow}`);
  assert.ok(out.resaleLow < out.resaleHigh);
});

test("thin comps downgrade a passing item to REVIEW", async () => {
  const [a] = S.parseDepopEmail(EMAIL);
  const out = await S.analyse(a, cfg, { compsProvider: async () => ({ sales: [200, 205, 210, 215], source: "test" }) });
  assert.equal(out.rating, "REVIEW");
});

test("fewer than 3 comps is treated as no comps", async () => {
  const [a] = S.parseDepopEmail(EMAIL);
  const out = await S.analyse(a, cfg, { compsProvider: async () => ({ sales: [200, 210], source: "test" }) });
  assert.equal(out.net, null);
  assert.equal(out.rating, "REVIEW");
});

test("fees and acquisition are subtracted, not ignored", async () => {
  const [a] = S.parseDepopEmail(EMAIL);
  const sales = new Array(12).fill(200);
  const out = await S.analyse(a, cfg, { compsProvider: async () => ({ sales, source: "test" }) });
  const f = S.FEES.ebay;
  assert.equal(out.fees, Math.round((200 * f.rate + f.fixed + f.ship) * 100) / 100);
  assert.equal(out.net, Math.round((200 - out.fees - 51) * 100) / 100);
});

test("replica wording is surfaced as a risk", async () => {
  const html = `<img src="https://m.depop.com/a.jpg" alt="Nike inspired hoodie">
    <p>Price $20.00</p><a href="https://www.depop.com/products/a-b-c/">x</a>`;
  const [l] = S.parseDepopEmail(html);
  const out = await S.analyse(l, { ...cfg, brands: [] });
  assert.ok(out.risks.some(r => /replica/i.test(r)));
});
