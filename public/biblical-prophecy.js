const html = String.raw;

const SCRIPTURAL_TESTS = [
  {
    number: "01",
    title: "The announced outcome must happen as spoken",
    passages: [
      ["Deuteronomy 18:21–22", "https://ebible.org/engwebp/DEU18.htm"],
      ["Jeremiah 28:9", "https://ebible.org/engwebp/JER28.htm"],
    ],
    rule: "A prophecy is tested against the observable outcome it actually announced, not against a later reinterpretation.",
  },
  {
    number: "02",
    title: "Stated conditions must remain part of the test",
    passages: [
      ["Jeremiah 18:7–10", "https://ebible.org/engwebp/JER18.htm"],
      ["Jonah 3:4–10", "https://ebible.org/engwebp/JON03.htm"],
    ],
    rule: "A warning tied to repentance or response is not judged as though it were an unconditional prediction.",
  },
  {
    number: "03",
    title: "Prophetic speech is weighed by other people",
    passages: [
      ["1 Corinthians 14:29", "https://ebible.org/engwebp/1CO14.htm"],
      ["1 Thessalonians 5:20–21", "https://ebible.org/engwebp/1TH05.htm"],
    ],
    rule: "The speaker does not certify the speaker. The claim and its evidence are weighed independently.",
  },
  {
    number: "04",
    title: "The original words control the result",
    passages: [
      ["1 Samuel 10:2–10", "https://ebible.org/engwebp/1SA10.htm"],
      ["Joshua 6:26; 1 Kings 16:34", "https://ebible.org/engwebp/1KI16.htm"],
    ],
    rule: "Scripture reports concrete signs and later outcomes against what was stated beforehand. We preserve the same source-to-outcome chain.",
  },
];

const CRITERIA = [
  ["Who", "The speaker, audience, actor, or people affected must be identifiable from the statement or its immediate context.", "Required"],
  ["What", "The event, action, sign, or outcome must be specific enough to compare with public evidence.", "Required"],
  ["Why", "The stated purpose, reason, warning, promise, or condition must be preserved because it can change what fulfillment means.", "Required"],
  ["Where", "The place must be named or fixed by context so the claim cannot move after the fact.", "Required"],
  ["When", "A date, period, sequence, deadline, or other bounded time relationship must be present.", "Required"],
  ["How", "Record the mechanism when it is stated. A prophecy is not rejected merely because the mechanism remains unstated until fulfillment.", "Record if stated"],
];

const EXAMPLES = [
  {
    number: "01",
    title: "Samuel gives Saul signs that occur",
    source: ["1 Samuel 10:2–8", "https://ebible.org/engwebp/1SA10.htm"],
    outcome: ["1 Samuel 10:9–10", "https://ebible.org/engwebp/1SA10.htm"],
    fields: [
      ["Who", "Samuel speaks to Saul; named travelers and prophets are involved."],
      ["What", "A sequence of meetings, gifts, music, and Saul prophesying is announced."],
      ["Why", "The signs confirm the calling and that God is with Saul."],
      ["Where", "Rachel’s tomb, the oak of Tabor, and the hill of God are identified."],
      ["When", "The signs are ordered to occur after Saul leaves Samuel; the narrative reports them that day."],
      ["How", "The mechanism and sequence are described in detail."],
    ],
    conclusion: "Derived rule: preserve the announced signs, order, people, places, and purpose, then compare them with the reported outcome.",
  },
  {
    number: "02",
    title: "Joshua’s word about rebuilding Jericho is reported fulfilled",
    source: ["Joshua 6:26", "https://ebible.org/engwebp/JOS06.htm"],
    outcome: ["1 Kings 16:34", "https://ebible.org/engwebp/1KI16.htm"],
    fields: [
      ["Who", "The rebuilder is described in advance; the later account names Hiel."],
      ["What", "Jericho is rebuilt at the cost of the rebuilder’s sons."],
      ["Why", "The statement is a curse connected to the devoted city."],
      ["Where", "Jericho is fixed and cannot be substituted later."],
      ["When", "The foundation and gates provide an ordered fulfillment sequence."],
      ["How", "The stated cost is tied to the firstborn and youngest son."],
    ],
    conclusion: "Derived rule: fulfillment should be traceable to the same actor class, event, place, sequence, and stated consequence.",
  },
  {
    number: "03",
    title: "Nineveh shows why conditions and purpose matter",
    source: ["Jonah 1:2; 3:4", "https://ebible.org/engwebp/JON03.htm"],
    outcome: ["Jonah 3:5–10", "https://ebible.org/engwebp/JON03.htm"],
    fields: [
      ["Who", "Jonah warns the people of Nineveh."],
      ["What", "Nineveh is warned of coming overthrow."],
      ["Why", "Its wickedness is named; the warning produces repentance."],
      ["Where", "Nineveh is explicitly identified."],
      ["When", "Forty days supplies the bounded period."],
      ["How", "The destruction mechanism is not stated, so the field remains open."],
    ],
    conclusion: "Derived rule: record purpose and conditions before judging the outcome. Missing How is not failure; ignoring a stated condition is bad testing.",
  },
];

function passageLinks(passages) {
  return passages.map(([label, url]) => html`<a href="${url}" rel="noreferrer">${label} <span aria-hidden="true">↗</span></a>`).join("");
}

function testCard(item) {
  return html`<article class="scriptural-test">
    <span class="study-example-number" aria-hidden="true">${item.number}</span>
    <div><h3>${item.title}</h3><nav aria-label="Scriptural basis">${passageLinks(item.passages)}</nav><p>${item.rule}</p></div>
  </article>`;
}

function exampleCard(example) {
  return html`<article class="study-example">
    <div class="study-example-number" aria-hidden="true">${example.number}</div>
    <div>
      <p class="study-method-label">Example from Scripture</p>
      <h3>${example.title}</h3>
      <div class="passage-pair">
        <a href="${example.source[1]}" rel="noreferrer">Prophecy: ${example.source[0]} <span aria-hidden="true">↗</span></a>
        <span aria-hidden="true">→</span>
        <a href="${example.outcome[1]}" rel="noreferrer">Outcome: ${example.outcome[0]} <span aria-hidden="true">↗</span></a>
      </div>
      <dl class="criteria-fields">${example.fields.map(([name, value]) => html`<div><dt>${name}</dt><dd>${value}</dd></div>`).join("")}</dl>
      <p class="criteria-conclusion">${example.conclusion}</p>
    </div>
  </article>`;
}

export function renderBiblicalProphecy(main) {
  main.innerHTML = html`
    <article class="biblical-study">
      <section class="biblical-study-hero paper" aria-labelledby="biblical-study-title">
        <div class="case-rail" aria-hidden="true"><span>SCRIPTURE</span><i></i><span>OUR STANDARD</span></div>
        <div>
          <p class="eyebrow"><span class="signal-dot"></span>Why these testing criteria</p>
          <h1 id="biblical-study-title">How Scripture teaches us to test prophecy</h1>
          <p class="lede">We assume Scripture is true. We study passages where prophecy is stated, weighed, and shown fulfilled or conditionally resolved. That pattern supplies the working criteria used for modern public prophecy.</p>
          <p class="study-boundary">Scripture is the example and authority from which the testing method is derived.</p>
        </div>
      </section>

      <section class="section-wrap study-overview" aria-labelledby="basis-title">
        <header class="study-section-heading">
          <div><p class="eyebrow">The scriptural basis</p><h2 id="basis-title">The criteria come from Scripture, not our preference.</h2></div>
          <p>Scripture gives both explicit instructions for testing prophetic speech and narrative examples where an earlier word is compared with a later outcome.</p>
        </header>
        <div class="scriptural-test-list">${SCRIPTURAL_TESTS.map(testCard).join("")}</div>
      </section>

      <section class="section-wrap study-elements" aria-labelledby="elements-title">
        <header class="study-section-heading">
          <div><p class="eyebrow">What a clear claim includes</p><h2 id="elements-title">The details must be specific enough to check.</h2></div>
          <p>The details may appear in the statement or its immediate source context. How is recorded when stated, but its absence does not disqualify a claim.</p>
        </header>
        <dl class="element-matrix">
          ${CRITERIA.map(([name, description, status]) => html`<div><dt>${name}</dt><dd>${description}</dd><span>${status}</span></div>`).join("")}
        </dl>
        <p class="study-measure-note"><strong>Why require these fields?</strong> Without them, a claim can move after the fact: the subject changes, the event becomes metaphorical, the location shifts, or the deadline disappears. Specificity protects both the speaker and the reviewer.</p>
      </section>

      <section class="section-wrap study-examples" aria-labelledby="examples-title">
        <header class="study-section-heading">
          <div><p class="eyebrow">Examples from Scripture</p><h2 id="examples-title">How these rules apply to the text.</h2></div>
          <p>Each example shows the statement, the reported outcome, and the details that a fair modern review must preserve.</p>
        </header>
        <div class="study-example-list">${EXAMPLES.map(exampleCard).join("")}</div>
      </section>

      <section class="section-wrap study-method" aria-labelledby="modern-gate-title">
        <header class="study-section-heading">
          <div><p class="eyebrow">How we apply this today</p><h2 id="modern-gate-title">A public claim must match its original words and the evidence.</h2></div>
          <p>We test only what was publicly stated before the outcome. We do not judge faith, motives, sincerity, calling, or spiritual office.</p>
        </header>
        <div class="pair-flow" aria-label="Modern prophecy review sequence">
          <span>Exact dated statement</span><i aria-hidden="true">→</i><span>Who · What · Why · Where · When</span><i aria-hidden="true">→</i><span>How and conditions, if stated</span><i aria-hidden="true">→</i><span>Evidence for and against</span><i aria-hidden="true">→</i><span>One named human decision</span>
        </div>
        <div class="study-metric-rules">
          <article><strong>Include</strong><p>A specific claim with a saved original source and an observable outcome.</p></article>
          <article><strong>Leave out</strong><p>General encouragement, flexible symbolism, private feelings, and statements with no public way to tell whether they happened.</p></article>
          <article><strong>Keep intact</strong><p>Every stated condition, purpose, deadline, and mechanism without adding details later.</p></article>
        </div>
      </section>

    </article>`;
}
