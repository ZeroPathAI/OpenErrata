import assert from "node:assert/strict";
import { test } from "node:test";
import { wikipediaHtmlToNormalizedText } from "../../../api/src/lib/services/content-fetcher.js";
import { wikipediaAdapter } from "../../src/content/adapters/wikipedia.js";
import { assertReady, withWindow } from "../helpers/adapter-harness.js";

// ── Wikipedia boilerplate across languages ──────────────────────────────────
// Each case is a trimmed copy of Parse API output (2026-10) for an article on
// that wiki: the same tags, classes, roles and heading markup, with most of
// the text cut. Appendix sections, hatnotes, navboxes, authority control,
// person-data tables, maintenance banners, sister-project boxes and portal
// bars must leave both the browser's text and the API's canonical text, and
// the two must stay identical; the prose stays.

interface BoilerplateCase {
  name: string;
  url: string;
  parserOutput: string;
  expectedText: string;
}

const heading = (level: 2 | 3, title: string): string =>
  `<div class="mw-heading mw-heading${level.toString()}"><h${level.toString()} id="${title.replace(/ /g, "_")}">${title}</h${level.toString()}><span class="mw-editsection"><span class="mw-editsection-bracket">[</span><a href="/w/index.php?action=edit"><span>edit</span></a><span class="mw-editsection-bracket">]</span></span></div>`;

const references = `<div class="mw-references-wrap"><ol class="references"><li id="cite_note-1"><span class="mw-cite-backlink"><a href="#cite_ref-1">↑</a></span> <span class="reference-text">A cited source, 1911.</span></li></ol></div>`;

const CASES: BoilerplateCase[] = [
  {
    name: "en: hatnotes, series sidebar and maintenance banner (See also stays)",
    url: "https://en.wikipedia.org/wiki/OpenAI",
    parserOutput: `
      <div role="note" class="hatnote navigation-not-searchable">Not to be confused with <a href="/wiki/OpenAL">OpenAL</a>.</div>
      <table class="sidebar sidebar-collapse nomobile nowraplinks hlist" role="navigation"><tbody><tr><td class="sidebar-pretitle">Part of a series on</td></tr><tr><th class="sidebar-title-with-pretitle"><a href="/wiki/Artificial_intelligence">Artificial intelligence (AI)</a></th></tr></tbody></table>
      <p>OpenAI is an artificial intelligence organization.</p>
      ${heading(2, "Governance")}
      <table class="box-Recentism plainlinks metadata ambox ambox-style ambox-Recentism" role="presentation"><tbody><tr><td class="mbox-text">This section appears to be slanted towards recent events.</td></tr></tbody></table>
      <div role="note" class="hatnote navigation-not-searchable">Main article: <a href="/wiki/Removal_of_Sam_Altman">Removal of Sam Altman from OpenAI</a></div>
      <p>The board removed its chief executive in 2023.</p>
      ${heading(2, "See also")}
      <ul><li><a href="/wiki/Anthropic">Anthropic</a></li></ul>
      ${heading(2, "References")}
      ${references}
      ${heading(2, "Further reading")}
      <ul><li>A book about the company.</li></ul>
      ${heading(2, "External links")}
      <ul><li><a class="external text" href="https://openai.com">Official website</a></li></ul>`,
    expectedText:
      "OpenAI is an artificial intelligence organization. Governance The board removed its chief executive in 2023. See also Anthropic",
  },
  {
    name: "de: main-article links, appendix sections, navbox, authority control, person data",
    url: "https://de.wikipedia.org/wiki/Marie_Curie",
    parserOutput: `
      <p>Marie Curie war eine Physikerin.</p>
      ${heading(2, "Leben und Wirken")}
      <div class="hauptartikel" role="navigation"><span class="hauptartikel-pfeil" title="siehe" aria-hidden="true" role="presentation">→&nbsp;</span><i><span class="hauptartikel-text">Hauptartikel</span>: <a href="/wiki/Radium">Radium</a></i></div>
      <p>Sie entdeckte Polonium und Radium.</p>
      ${heading(2, "Siehe auch")}
      <ul><li><a href="/wiki/Pierre_Curie">Pierre Curie</a></li></ul>
      ${heading(2, "Nachweise")}
      ${heading(3, "Literatur")}
      <ul><li>P. Adloff (Hrsg.): 100 Years after the Discovery of Radiochemistry. 1996.</li></ul>
      ${heading(3, "Einzelnachweise")}
      ${references}
      ${heading(2, "Weblinks")}
      <div class="sisterproject" style="margin:0.1em 0 0 0;"><b><a href="https://commons.wikimedia.org">Commons</a></b>: Marie Curie – Sammlung von Bildern</div>
      <ul><li>Informationen der Nobelstiftung zur Preisverleihung 1911</li></ul>`,
    expectedText:
      "Marie Curie war eine Physikerin. Leben und Wirken Sie entdeckte Polonium und Radium. Siehe auch Pierre Curie",
  },
  {
    name: "de: navbox, Normdaten and Personendaten after a kept section",
    url: "https://de.wikipedia.org/wiki/Photosynthese",
    parserOutput: `
      <p>Die Photosynthese ist ein Prozess.</p>
      ${heading(2, "Siehe auch")}
      <ul><li><a href="/wiki/Chemosynthese">Chemosynthese</a></li></ul>
      <div class="BoxenVerschmelzen"><div class="klappleiste mw-collapsible navileiste navigation-not-searchable center" role="navigation"><div class="klappleiste-kopf"><a href="/wiki/Liste">Träger des Nobelpreises für Chemie</a></div><div class="klappleiste-inhalt mw-collapsible-content"><p>1901:&nbsp;<a href="/wiki/Hoff">van ’t Hoff</a>&nbsp;| 1902:&nbsp;<a href="/wiki/Fischer">E. Fischer</a></p></div></div></div>
      <div class="hintergrundfarbe1 rahmenfarbe1 navigation-not-searchable normdaten-typ-s" id="normdaten"><div><div>Normdaten&nbsp;(Sachbegriff): <a href="/wiki/Gemeinsame_Normdatei">GND</a>: <span class="plainlinks-print"><a class="external text" href="https://d-nb.info/gnd/4045936-6">4045936-6</a></span></div></div></div>
      <table class="metadata rahmenfarbe1" id="Vorlage_Personendaten" style="border-style: solid; margin-top: 20px;"><tbody><tr><th colspan="2"><a href="/wiki/Hilfe:Personendaten">Personendaten</a></th></tr><tr><td style="color: #aaa;">NAME</td><td style="font-weight: bold;">Curie, Marie</td></tr></tbody></table>`,
    expectedText: "Die Photosynthese ist ein Prozess. Siehe auch Chemosynthese",
  },
  {
    name: "fr: bandeaux, appendix subsections, portal bar and quality label",
    url: "https://fr.wikipedia.org/wiki/Marie_Curie",
    parserOutput: `
      <div class="bandeau-container metadata homonymie hatnote"><div class="bandeau-cell bandeau-icone" style="display:table-cell;padding-right:0.5em"></div><div class="bandeau-cell" style="display:table-cell">Pour les articles homonymes, voir <a href="/wiki/Curie">Curie</a>.</div></div>
      <p>Marie Curie est une physicienne.</p>
      ${heading(2, "Biographie")}
      <div class="bandeau-container bandeau-section metadata bandeau-niveau-information"><div class="bandeau-cell bandeau-icone-css loupe">Article détaillé&nbsp;: <a href="/wiki/Institut_du_radium">Institut du radium</a>.</div></div>
      <p>Elle fonde l'Institut du radium.</p>
      ${heading(2, "Notes et références")}
      ${references}
      ${heading(2, "Voir aussi")}
      ${heading(3, "Bibliographie")}
      <div class="colonnes"><ul><li>Ève Curie, <i>Madame Curie</i>, Gallimard, 1938</li></ul></div>
      ${heading(3, "Liens externes")}
      <ul><li>Biographie sur le site de la fondation Nobel</li></ul>
      ${heading(3, "Articles connexes")}
      <ul><li><a href="/wiki/Radioactivit%C3%A9">Radioactivité</a></li></ul>
      <ul id="bandeau-portail" class="bandeau-portail"><li><span class="bandeau-portail-element"><span class="bandeau-portail-texte"><a href="/wiki/Portail:Physique">Portail de la physique</a></span></span></li></ul>
      <div id="article_de_qualite" class="bandeau-container metadata bandeau-simple bandeau-niveau-neutre"><div class="bandeau-cell">La version du 27 janvier 2006 de cet article a été reconnue comme « article de qualité ».</div></div>`,
    expectedText:
      "Marie Curie est une physicienne. Biographie Elle fonde l'Institut du radium. Voir aussi Articles connexes Radioactivité",
  },
  {
    name: "fr read view: each section nested in its own <section> element",
    url: "https://fr.wikipedia.org/wiki/Jupiter_(plan%C3%A8te)",
    parserOutput: `
      <section data-mw-section-id="0"><p>Jupiter est une planète géante.</p></section>
      <section data-mw-section-id="1">${heading(2, "Observation")}<p>Jupiter est visible à l'œil nu.</p></section>
      <section data-mw-section-id="2">${heading(2, "Notes et références")}${references}</section>
      <section data-mw-section-id="3">${heading(2, "Voir aussi")}
        <section data-mw-section-id="4">${heading(3, "Bibliographie")}<ul><li>Guillaume Cannat, Jupiter et Saturne en direct, 2005.</li></ul></section>
        <section data-mw-section-id="5">${heading(3, "Articles connexes")}<ul><li><a href="/wiki/Anneaux_de_Jupiter">Anneaux de Jupiter</a></li></ul></section>
        <section data-mw-section-id="6">${heading(3, "Liens externes")}<ul><li>Le Système Solaire - Jupiter.</li></ul><ul id="bandeau-portail" class="bandeau-portail"><li>Portail de l'astronomie</li></ul></section>
      </section>`,
    expectedText:
      "Jupiter est une planète géante. Observation Jupiter est visible à l'œil nu. Voir aussi Articles connexes Anneaux de Jupiter",
  },
  {
    name: "es: references, bibliography and external links with authority control",
    url: "https://es.wikipedia.org/wiki/Marie_Curie",
    parserOutput: `
      <p>Marie Curie fue una física.</p>
      ${heading(2, "Véase también")}
      <ul><li><a href="/wiki/Radio">Radio</a></li></ul>
      ${heading(2, "Referencias")}
      ${references}
      ${heading(2, "Bibliografía consultada")}
      <ul><li>Borzendowski, Janice (2009). Marie Curie.</li></ul>
      ${heading(2, "Enlaces externos")}
      <ul><li>Wikimedia Commons alberga una galería multimedia sobre Marie Curie.</li></ul>
      <div class="mw-authority-control"><div role="navigation" class="navbox" aria-label="Navbox"><table class="hlist navbox-inner"><tbody><tr><th scope="row" class="navbox-group">Control de autoridades</th><td class="navbox-list">Datos: Q7186</td></tr></tbody></table></div></div>`,
    expectedText: "Marie Curie fue una física. Véase también Radio",
  },
  {
    name: "it: notes, bibliography, other projects and external links",
    url: "https://it.wikipedia.org/wiki/Marie_Curie",
    parserOutput: `
      <p>Marie Curie è stata una fisica.</p>
      ${heading(2, "Note")}
      ${references}
      ${heading(2, "Bibliografia")}
      <ul><li>Françoise Giroud, Marie Curie, Rizzoli, 1982.</li></ul>
      ${heading(2, "Voci correlate")}
      <ul><li><a href="/wiki/Donne_nella_scienza">Donne nella scienza</a></li></ul>
      ${heading(2, "Altri progetti")}
      <div id="interProject" style="display: none; clear: both;"><div>Altri progetti</div><ul><li><a href="https://it.wikiquote.org">Wikiquote</a></li></ul></div>
      <ul><li>Wikiquote contiene citazioni di o su Marie Curie</li></ul>
      ${heading(2, "Collegamenti esterni")}
      <ul><li>Curie, Pierre e Marie, su Treccani.it</li></ul>
      <table class="CdA"><tbody><tr><th><a href="/wiki/Aiuto:Controllo_di_autorit%C3%A0">Controllo di autorità</a></th><td>VIAF 76353174</td></tr></tbody></table>`,
    expectedText: "Marie Curie è stata una fisica. Voci correlate Donne nella scienza",
  },
  {
    name: "pt: main-article hatnotes and appendix sections",
    url: "https://pt.wikipedia.org/wiki/J%C3%BApiter_(planeta)",
    parserOutput: `
      <p>Júpiter é o maior planeta.</p>
      ${heading(2, "Atmosfera")}
      <div role="note" class="hatnote navigation-not-searchable">Ver artigo principal: <a href="/wiki/Atmosfera_de_J%C3%BApiter">Atmosfera de Júpiter</a></div>
      <p>A atmosfera é composta de hidrogênio.</p>
      ${heading(2, "Ver também")}
      <ul><li><a href="/wiki/Exoplaneta">Exoplaneta</a></li></ul>
      ${heading(2, "Notas")}
      <ul><li>Este artigo foi traduzido do inglês.</li></ul>
      ${heading(2, "Referências")}
      ${references}
      ${heading(2, "Ligações externas")}
      <div id="interProject" style="display:none;"><a href="https://commons.wikimedia.org">Commons</a></div>
      <ul><li>NASA Jupiter</li></ul>`,
    expectedText:
      "Júpiter é o maior planeta. Atmosfera A atmosfera é composta de hidrogênio. Ver também Exoplaneta",
  },
  {
    name: "nl: appendix box, navigation template and sister-project box",
    url: "https://nl.wikipedia.org/wiki/Jupiter_(planeet)",
    parserOutput: `
      <p>Jupiter is de grootste planeet.</p>
      <div class="toccolours appendix" role="presentation" style="font-size:90%; margin:1em 0 -0.5em; clear:both;"><div><span style="font-weight:bold">Voetnoten</span></div><div class="reflist" style="list-style-type: decimal;">${references}</div><p><b>Externe links</b></p><ul><li>(en) Jupiter Fact Sheet</li></ul></div>
      <div class="navigatie" role="navigation" aria-labelledby="Het_zonnestelsel"><table class="navigatie-tabel"><tbody><tr><td><a href="/wiki/Zonnestelsel">Het zonnestelsel</a> · <a href="/wiki/Mercurius_(planeet)">Mercurius</a></td></tr></tbody></table></div>
      <div class="interProject commons mw-list-item" style="display:none;"><a class="extiw" href="https://commons.wikimedia.org/wiki/Category:Jupiter">Mediabestanden</a></div>
      <div class="interProjectTemplate interProject-groot toccolours" style="display:flex; gap:1em;"><div>Zie de categorie <a href="https://commons.wikimedia.org">Jupiter (planet)</a> van Wikimedia Commons voor mediabestanden over dit onderwerp.</div></div>`,
    expectedText: "Jupiter is de grootste planeet.",
  },
  {
    name: "pl: footnotes, notes, further reading and external links",
    url: "https://pl.wikipedia.org/wiki/Jowisz",
    parserOutput: `
      <p>Jowisz jest największą planetą.</p>
      ${heading(2, "Zobacz też")}
      <ul><li><a href="/wiki/Gazowy_olbrzym">gazowy olbrzym</a></li></ul>
      ${heading(2, "Uwagi")}
      ${references}
      ${heading(2, "Przypisy")}
      ${references}
      ${heading(2, "Dalsza literatura")}
      <ul><li>Bagenal, F.: Jupiter: The planet, satellites, and magnetosphere. 2004.</li></ul>
      ${heading(2, "Linki zewnętrzne")}
      <ul><li>Jowisz w serwisie NASA</li></ul>`,
    expectedText: "Jowisz jest największą planetą. Zobacz też gazowy olbrzym",
  },
  {
    name: "ru: hatnotes and appendix sections",
    url: "https://ru.wikipedia.org/wiki/%D0%AE%D0%BF%D0%B8%D1%82%D0%B5%D1%80",
    parserOutput: `
      <div role="note" class="hatnote navigation-not-searchable dabhide">См. также: <a href="/wiki/Atm">Атмосфера Юпитера</a></div>
      <p>Юпитер — крупнейшая планета.</p>
      ${heading(2, "См. также")}
      <ul><li><a href="/wiki/Gas">Газовый гигант</a></li></ul>
      ${heading(2, "Примечания")}
      ${references}
      ${heading(2, "Литература")}
      <ul><li>Маров М. Я. Планеты Солнечной системы. 1986.</li></ul>
      ${heading(2, "Ссылки")}
      <ul><li>Факты о Юпитере на сайте НАСА</li></ul>`,
    expectedText: "Юпитер - крупнейшая планета. См. также Газовый гигант", // dashes normalize to "-"
  },
  {
    name: "ja: sister-project box and appendix sections",
    url: "https://ja.wikipedia.org/wiki/%E6%9C%A8%E6%98%9F",
    parserOutput: `
      <p>木星は太陽系最大の惑星である。</p>
      ${heading(2, "関連項目")}
      <ul><li><a href="/wiki/Gas">巨大ガス惑星</a></li></ul>
      ${heading(2, "脚注")}
      ${heading(3, "出典")}
      ${references}
      ${heading(2, "参考文献")}
      <ul><li>松井孝典『惑星科学入門』講談社、1996年。</li></ul>
      ${heading(2, "外部リンク")}
      <div role="navigation" aria-labelledby="sister-projects" class="side-box metadata side-box-right sister-box sistersitebox plainlinks"><div class="side-box-abovebelow">ウィキペディアの姉妹プロジェクトで「木星」に関する情報が検索できます。</div></div>
      <ul><li>理科ねっとわーく 太陽系図鑑（木星）</li></ul>`,
    expectedText: "木星は太陽系最大の惑星である。 関連項目 巨大ガス惑星",
  },
  {
    name: "zh: hatnote and appendix sections in either script",
    url: "https://zh.wikipedia.org/wiki/%E6%9C%A8%E6%98%9F",
    parserOutput: `
      <div role="note" class="hatnote navigation-not-searchable">主条目：<a href="/wiki/Atm">木星大氣層</a></div>
      <p>木星是太陽系中最大的行星。</p>
      ${heading(2, "相關條目")}
      <ul><li><a href="/wiki/Hot">熱木星</a></li></ul>
      ${heading(2, "註解")}
      ${references}
      ${heading(2, "參考資料")}
      ${references}
      ${heading(2, "延伸阅读")}
      <ul><li>Bagenal, F. Jupiter. 2004.</li></ul>
      ${heading(2, "外部連結")}
      <ul><li>NASA 木星</li></ul>`,
    expectedText: "木星是太陽系中最大的行星。 相關條目 熱木星",
  },
];

function clientText(boilerplateCase: BoilerplateCase): string {
  const page = `<!doctype html>
    <html>
      <head>
        <script>
          RLCONF={"wgNamespaceNumber":0,"wgPageName":"Article","wgArticleId":12345,"wgRevisionId":67890,"wgRevisionTimestamp":"20261001000000"};
        </script>
      </head>
      <body>
        <div id="mw-content-text"><div class="mw-parser-output">${boilerplateCase.parserOutput}</div></div>
      </body>
    </html>`;
  return withWindow(
    boilerplateCase.url,
    page,
    (document) => assertReady(wikipediaAdapter.extract(document)).content.contentText,
  );
}

for (const boilerplateCase of CASES) {
  test(`Wikipedia canonical text keeps only prose — ${boilerplateCase.name}`, () => {
    const serverText = wikipediaHtmlToNormalizedText(
      `<div class="mw-parser-output">${boilerplateCase.parserOutput}</div>`,
    );
    assert.equal(serverText, boilerplateCase.expectedText);
    assert.equal(clientText(boilerplateCase), serverText);
  });
}
