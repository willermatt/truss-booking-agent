/**
 * Address parsing and comparison for duplicate detection.
 *
 * Rules:
 *   - Harmless differences are normalized away: case, punctuation, spacing, "Street"/"St",
 *     "West"/"W", "Apt 4B"/"#4B"/"Unit 4b", "First"/"1st", ZIP+4 → ZIP.
 *   - Meaningful parts are preserved: house number, street name, directionals (E vs W), street type
 *     (St vs Ave), unit, and ZIP. Any one of these present on both sides and different means a
 *     different property.
 *   - If one side is missing a part the other has (no unit, no directional, no ZIP, no street type), or
 *     one street name only extends the other, the relation is AMBIGUOUS. Ambiguous blocks the job and
 *     requires manual booking.
 *
 * The same rules are implemented in SQL (safety._property_relation) for the database's own duplicate
 * check; test/address.test.ts runs every case through both and requires identical answers.
 */

export interface ParsedAddress {
  /** House number, e.g. "1700" or "12a". Empty if none was found. */
  number: string;
  /** Street name tokens, normalized, e.g. "washington" or "1st". */
  name: string;
  /** Directionals (pre and post), e.g. "w", "n", "w nw". Empty if none. */
  dir: string;
  /** Canonical street type, e.g. "st", "ave". Empty if none. */
  suffix: string;
  /** Unit: alphanumeric groups joined by "-", e.g. "4b" or "1-2". Empty if none. */
  unit: string;
  /** Five-digit ZIP. Empty if none. */
  zip: string;
  /** False when some text could not be placed (for example a city typed into the street line). */
  clean: boolean;
  /** Every street word after the house number, normalized and in order: "e mountain vw rd". */
  tokens: string;
}

export type PropertyRelation = 'same' | 'ambiguous' | 'different';

const DIRECTIONALS: Record<string, string> = {
  n: 'n', s: 's', e: 'e', w: 'w', ne: 'ne', nw: 'nw', se: 'se', sw: 'sw',
  north: 'n', south: 's', east: 'e', west: 'w',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
};

// USPS street suffixes (Publication 28, C1) mapped to their standard abbreviation.
const SUFFIX_GROUPS: [string, string[]][] = [
  ['aly', ['alley', 'allee', 'ally']], ['anx', ['annex', 'anex']], ['arc', ['arcade']], ['ave', ['avenue', 'av', 'aven', 'avn', 'avenu']],
  ['byu', ['bayou', 'bayoo']], ['bch', ['beach']], ['bnd', ['bend']], ['blf', ['bluff']], ['blfs', ['bluffs']], ['btm', ['bottom', 'bot']],
  ['blvd', ['boulevard', 'boul', 'boulv']], ['br', ['branch', 'brnch']], ['brg', ['bridge', 'brdge']], ['brk', ['brook']], ['brks', ['brooks']],
  ['byp', ['bypass', 'bypa', 'bypas', 'byps']], ['cp', ['camp']], ['cyn', ['canyon', 'canyn', 'cnyn']], ['cpe', ['cape']],
  ['cswy', ['causeway', 'causwa']], ['ctr', ['center', 'centre', 'cent', 'centr', 'cnter', 'cntr']], ['ctrs', ['centers']],
  ['cir', ['circle', 'circ', 'circl', 'crcl', 'crcle']], ['cirs', ['circles']], ['clf', ['cliff']], ['clfs', ['cliffs']], ['clb', ['club']],
  ['cmn', ['common']], ['cmns', ['commons']], ['cor', ['corner']], ['cors', ['corners']], ['crse', ['course']], ['ct', ['court']],
  ['cts', ['courts']], ['cv', ['cove']], ['cvs', ['coves']], ['crk', ['creek']], ['cres', ['crescent', 'crsent', 'crsnt']], ['crst', ['crest']],
  ['xing', ['crossing', 'crssng']], ['xrd', ['crossroad']], ['xrds', ['crossroads']], ['curv', ['curve']], ['dl', ['dale']], ['dm', ['dam']],
  ['dv', ['divide', 'div', 'dvd']], ['dr', ['drive', 'driv', 'drv']], ['drs', ['drives']], ['est', ['estate']], ['ests', ['estates']],
  ['expy', ['expressway', 'exp', 'expr', 'express', 'expw']], ['ext', ['extension', 'extn', 'extnsn']], ['exts', ['extensions']],
  ['fls', ['falls']], ['fry', ['ferry', 'frry']], ['fld', ['field']], ['flds', ['fields']], ['flt', ['flat']], ['flts', ['flats']],
  ['frd', ['ford']], ['frds', ['fords']], ['frst', ['forest']], ['frsts', ['forests']], ['frg', ['forge', 'forg']], ['frgs', ['forges']], ['frk', ['fork']],
  ['frks', ['forks']], ['ft', ['fort', 'frt']], ['fwy', ['freeway', 'freewy', 'frway', 'frwy']], ['gdn', ['garden', 'gardn', 'grden', 'grdn']],
  ['gdns', ['gardens', 'grdns']], ['gtwy', ['gateway', 'gatewy', 'gatway', 'gtway']], ['gln', ['glen']], ['glns', ['glens']],
  ['grn', ['green']], ['grns', ['greens']], ['grv', ['grove', 'grov']], ['grvs', ['groves']], ['hbr', ['harbor', 'harb', 'harbr', 'hrbor']],
  ['hbrs', ['harbors']], ['hvn', ['haven']], ['hts', ['heights', 'ht']], ['hwy', ['highway', 'highwy', 'hiway', 'hiwy', 'hway']],
  ['hl', ['hill']], ['hls', ['hills']], ['holw', ['hollow', 'hllw']], ['holws', ['hollows']], ['inlt', ['inlet']], ['is', ['island', 'islnd']],
  ['iss', ['islands', 'islnds']], ['jct', ['junction', 'jction', 'jctn', 'junctn', 'juncton']], ['jcts', ['junctions', 'jctns']],
  ['ky', ['key']], ['kys', ['keys']], ['knl', ['knoll', 'knol']], ['knls', ['knolls']], ['lk', ['lake']], ['lks', ['lakes']],
  ['lndg', ['landing', 'lndng']], ['ln', ['lane']], ['lgt', ['light']], ['lgts', ['lights']], ['lf', ['loaf']], ['lck', ['lock']],
  ['lcks', ['locks']], ['ldg', ['lodge', 'ldge', 'lodg']], ['mnr', ['manor']], ['mnrs', ['manors']], ['mdw', ['meadow']],
  ['mdws', ['meadows', 'medows']], ['ml', ['mill']], ['mls', ['mills']], ['msn', ['mission', 'missn', 'mssn']], ['mtwy', ['motorway']],
  ['mt', ['mount', 'mnt']], ['mtn', ['mountain', 'mntain', 'mntn', 'mountin', 'mtin']], ['mtns', ['mountains', 'mntns']], ['nck', ['neck']],
  ['orch', ['orchard', 'orchrd']], ['opas', ['overpass']], ['pkwy', ['parkway', 'parkwy', 'pkway', 'pky']], ['pkwys', ['parkways']],
  ['psge', ['passage']], ['pne', ['pine']], ['pnes', ['pines']], ['pl', ['place']], ['pln', ['plain']], ['plns', ['plains']],
  ['plz', ['plaza', 'plza']], ['pt', ['point']], ['pts', ['points']], ['prt', ['port']], ['prts', ['ports']], ['pr', ['prairie', 'prr']],
  ['radl', ['radial', 'rad', 'radiel']], ['rnch', ['ranch']], ['rnchs', ['ranches']], ['rpd', ['rapid']], ['rpds', ['rapids']], ['rst', ['rest']],
  ['rdg', ['ridge', 'rdge']], ['rdgs', ['ridges']], ['riv', ['river', 'rvr', 'rivr']], ['rd', ['road']], ['rds', ['roads']], ['rte', ['route']],
  ['shl', ['shoal']], ['shls', ['shoals']], ['shr', ['shore', 'shoar']], ['shrs', ['shores', 'shoars']], ['skwy', ['skyway']],
  ['spg', ['spring', 'spng', 'sprng']], ['spgs', ['springs', 'spngs', 'sprngs']], ['sq', ['square', 'sqr', 'sqre', 'squ']], ['sqs', ['squares', 'sqrs']],
  ['sta', ['station', 'statn', 'stn']], ['stra', ['stravenue', 'strav', 'straven', 'stravn', 'strvn', 'strvnue']],
  ['strm', ['stream', 'streme']], ['st', ['street', 'strt', 'str']], ['sts', ['streets']], ['smt', ['summit', 'sumit', 'sumitt']],
  ['ter', ['terrace', 'terr']], ['trwy', ['throughway']], ['trce', ['trace']], ['trces', ['traces']], ['trak', ['track', 'trk']], ['traks', ['tracks', 'trks']],
  ['trfy', ['trafficway']], ['trl', ['trail']], ['trls', ['trails']], ['trlr', ['trailer']], ['trlrs', ['trailers']], ['tunl', ['tunnel', 'tunel', 'tunnl']], ['tunls', ['tunnels']],
  ['tpke', ['turnpike', 'trnpk', 'turnpk']], ['upas', ['underpass']], ['un', ['union']], ['uns', ['unions']], ['vly', ['valley', 'vally', 'vlly']],
  ['vlys', ['valleys']], ['via', ['viaduct', 'vdct', 'viadct']], ['vw', ['view']], ['vws', ['views']], ['vlg', ['village', 'vill', 'villag', 'villg', 'villiage']],
  ['vlgs', ['villages']], ['vl', ['ville']], ['vis', ['vista', 'vist', 'vst', 'vsta']], ['wl', ['well']], ['wls', ['wells']],
  ['way', ['wy']], ['ways', []], ['loop', []], ['loops', []], ['mall', []], ['mews', []], ['oval', ['ovl']], ['park', []], ['parks', []], ['pass', []],
  ['path', []], ['paths', []], ['pike', []], ['pikes', []], ['ramp', []], ['row', []], ['rue', []], ['run', []], ['spur', []], ['spurs', []], ['walk', []], ['walks', []],
  ['wall', []], ['xing', []], ['fall', []], ['land', []],
];
const SUFFIXES: Record<string, string> = {};
for (const [abbr, words] of SUFFIX_GROUPS) { SUFFIXES[abbr] = abbr; for (const w of words) SUFFIXES[w] = abbr; }

/**
 * Words with a fixed meaning inside a street name ("St John" = "Saint John", "Mt View" = "Mount View"),
 * mapped to forms no street-type word shares, so "Street Rd" is not "Saint Rd".
 */
const NAME_WORDS: Record<string, string> = {
  saint: 'saint', st: 'saint', ste: 'saint', mount: 'mount', mt: 'mount', mnt: 'mount', fort: 'fort', ft: 'fort', frt: 'fort',
};

/** Unit words that name a different kind of unit; the rest (apt, unit, #, suite...) are interchangeable. */
const UNIT_KINDS: Record<string, string> = { bldg: 'bldg', building: 'bldg', lot: 'lot', spc: 'spc', space: 'spc', rm: 'rm', room: 'rm' };
const UNIT_KIND_PREFIX = /^(bldg|lot|spc|rm)-/;

const ORDINAL_UNITS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth'];
const ORDINAL_TEENS = ['tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth',
                       'seventeenth', 'eighteenth', 'nineteenth'];
const TENS = ['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const ORDINAL_TENS = ['twentieth', 'thirtieth', 'fortieth', 'fiftieth', 'sixtieth', 'seventieth', 'eightieth', 'ninetieth'];

/** 21 → "21st", 12 → "12th". */
export function ordinal(n: number): string {
  const last2 = n % 100;
  const suffix = last2 >= 11 && last2 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

const ORDINALS: Record<string, string> = {};
ORDINAL_UNITS.forEach((w, i) => { ORDINALS[w] = ordinal(i + 1); });
ORDINAL_TEENS.forEach((w, i) => { ORDINALS[w] = ordinal(i + 10); });
ORDINAL_TENS.forEach((w, i) => { ORDINALS[w] = ordinal((i + 2) * 10); });
TENS.forEach((t, i) => ORDINAL_UNITS.forEach((u, j) => { ORDINALS[`${t}-${u}`] = ordinal((i + 2) * 10 + j + 1); }));

/** "N W Grand Ave" and "N.W. Grand Ave" (the dots became spaces) mean "NW Grand Ave". */
function mergeSpacedDirectionals(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    if ((t === 'n' || t === 's') && (next === 'e' || next === 'w') && i + 2 < tokens.length) { out.push(t + next); i++; continue; }
    out.push(t);
  }
  return out;
}

/** Ordinal words become numbers ("Eleventh", "Twenty First", "twenty-first"). */
function normalizeOrdinals(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    if (TENS.includes(t) && next && ORDINAL_UNITS.includes(next)) { out.push(ORDINALS[`${t}-${next}`]); i++; continue; }
    out.push(ORDINALS[t] ?? t);
  }
  return out;
}

const UNIT_WORDS = new Set(['apt', 'apartment', 'unit', 'ste', 'suite', '#', 'no', 'bldg', 'building',
                            'lot', 'spc', 'space', 'rm', 'room']);

const STATES = new Set(['al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga', 'hi', 'id', 'il', 'in',
  'ia', 'ks', 'ky', 'la', 'me', 'md', 'ma', 'mi', 'mn', 'ms', 'mo', 'mt', 'ne', 'nv', 'nh', 'nj', 'nm', 'ny',
  'nc', 'nd', 'oh', 'ok', 'or', 'pa', 'ri', 'sc', 'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv', 'wi', 'wy',
  'dc', 'arizona']);

const isDir = (t: string) => t in DIRECTIONALS;
const isSuffix = (t: string) => t in SUFFIXES;
const isZip = (t: string) => /^\d{5}(-\d{4})?$/.test(t);

/** Accents removed ("Río" → "rio"). */
function fold(text: string): string {
  return text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

/** True when letters remain that are not plain ASCII after accents are removed. */
function hasForeignLetters(text: string): boolean {
  return /[^\x00-\x7f]/.test(fold(text).replace(/[’‘]/g, ''));
}

/** Lowercases, removes accents, drops periods/apostrophes, isolates "#", collapses spaces. */
function clean(text: string): string {
  return fold(text).toLowerCase().replace(/[’‘']/g, '').replace(/\./g, ' ').replace(/#/g, ' # ')
    .replace(/[^a-z0-9#,/ -]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** "Apt 4B" → "4b", "#4-B" → "4-b", "Unit 1-2" → "1-2". Separators between groups are kept. */
export function normalizeUnit(unit: string): string {
  const tokens = clean(unit).replace(/,/g, ' ').split(' ').filter(Boolean);
  // A building, lot, space or room keeps its kind ("Bldg 4" is not "Apt 4"); apt, unit, # and suite do not.
  const kind = tokens.length > 1 ? UNIT_KINDS[tokens[0]] : undefined;
  while (tokens.length > 1 && UNIT_WORDS.has(tokens[0])) tokens.shift();
  if (tokens.length === 1 && UNIT_WORDS.has(tokens[0]) && tokens[0] !== 'no') return '';
  // Leading zeros are not significant ("04" = "4"); separators are kept between groups.
  const value = tokens.flatMap((t) => t.split(/[^a-z0-9]+/)).filter(Boolean).map((g) => g.replace(/^0+(?=\d)/, '')).join('-');
  return kind && value ? `${kind}-${value}` : value;
}

/**
 * Same, ambiguous or different unit (both non-empty). Ambiguous when they differ only in separators
 * ("4-B" / "4B") or only in the kind of unit ("Bldg 4" / "Apt 4" / "Lot 4").
 */
function unitRelation(a: string, b: string): PropertyRelation {
  if (a === b) return 'same';
  const core = (u: string) => u.replace(UNIT_KIND_PREFIX, '').replace(/-/g, '');
  return core(a) === core(b) ? 'ambiguous' : 'different';
}

/** True when the word sequence `inner` appears, whole words, inside `outer`. */
function containsWords(outer: string, inner: string): boolean {
  return !!inner && ` ${outer} `.includes(` ${inner} `);
}

/** Pulls "City ST 85007" style locality text apart. Returns the ZIP and whether it fully understood it. */
function parseLocality(tokens: string[]): { zip: string; understood: boolean } {
  const t = [...tokens];
  let zip = '';
  if (t.length && isZip(t[t.length - 1])) zip = t.pop()!.slice(0, 5);
  let state = false;
  if (t.length && STATES.has(t[t.length - 1])) { t.pop(); state = true; }
  // Remaining words are a city name: understood only if a state or ZIP closed the locality.
  return { zip, understood: (state || zip !== '') && t.every((w) => /^[a-z]+$/.test(w)) };
}

/**
 * Parses a street line. `unit` and `zip` (when given separately) take part in the parse. Text after the
 * first comma is treated as unit or locality; a city typed without commas is detected only when it is
 * followed by a state and/or ZIP.
 */
export function parseAddress(street: string, unit?: string | null, zip?: string | null): ParsedAddress {
  const sections = clean(street).split(',').map((s) => s.trim()).filter(Boolean);
  const head = (sections[0] ?? '').split(' ').filter(Boolean);
  let parsedUnit = unit ? normalizeUnit(unit) : '';
  let parsedZip = zip && /^\d{5}/.test(zip.trim()) ? zip.trim().slice(0, 5) : '';
  // Intersections, "and", parentheses and the like are not a single street address; letters that are
  // not plain ASCII even without accents cannot be compared reliably.
  let isClean = !/[&@()\[\]]|\band\b/i.test(street) && !hasForeignLetters(street) && !hasForeignLetters(unit ?? '');

  // Later comma sections: a unit, or locality ("Phoenix", "AZ 85007").
  for (const section of sections.slice(1)) {
    const words = section.split(' ').filter(Boolean);
    if (UNIT_WORDS.has(words[0]) && words.length >= 2) {
      const u = normalizeUnit(section);
      if (parsedUnit && u && u !== parsedUnit) isClean = false;
      parsedUnit = parsedUnit || u;
      continue;
    }
    const loc = parseLocality(words);
    if (loc.zip) {
      if (parsedZip && parsedZip !== loc.zip) isClean = false;
      parsedZip = parsedZip || loc.zip;
    }
    // A bare city section ("Phoenix") is fine; anything with digits that is not a ZIP is not.
    if (/\d/.test(section) && !loc.zip) isClean = false;
  }

  // House number. Leading zeros are not significant ("01700" = "1700").
  let number = '';
  let tokens = head;
  const num = tokens.length ? /^0*(\d+)([a-z]?)$/.exec(tokens[0]) : null;
  if (num) {
    // "1700W Washington St" stays house "1700w": against "1700 W Washington St" (or "1700 E ...") that is
    // a lettered number, so ambiguous, never a confident "same" or "different".
    number = num[1] + num[2];
    tokens = tokens.slice(1);
  } else {
    isClean = false;
  }

  // Unit inside the street line: "... St Apt 4B", "... St #4B".
  const unitAt = tokens.findIndex((t, i) => i >= 1 && UNIT_WORDS.has(t) && i + 1 < tokens.length);
  let trailing: string[] = [];
  if (unitAt >= 0) {
    let j = unitAt + 1;
    if (tokens[j] === '#' && j + 1 < tokens.length) j++;
    const u = normalizeUnit(tokens[j]);
    if (parsedUnit && u && u !== parsedUnit) isClean = false;
    parsedUnit = parsedUnit || u;
    trailing = tokens.slice(j + 1);
    tokens = tokens.slice(0, unitAt);
  }

  tokens = mergeSpacedDirectionals(normalizeOrdinals(tokens));

  // Street type: the last suffix word with at least one word before it ("100 North St" → name "n").
  let suffixAt = -1;
  for (let i = tokens.length - 1; i >= 1; i--) {
    if (isSuffix(tokens[i])) { suffixAt = i; break; }
  }
  let suffix = '';
  let tail: string[] = [];
  let body = tokens;
  if (suffixAt >= 0) {
    suffix = SUFFIXES[tokens[suffixAt]];
    tail = tokens.slice(suffixAt + 1);
    body = tokens.slice(0, suffixAt);
  }

  // Post-directional, then anything left over is locality typed without commas, or junk.
  let postDir = '';
  if (tail.length && isDir(tail[0])) { postDir = DIRECTIONALS[tail[0]]; tail = tail.slice(1); }
  if (suffixAt < 0 && body.length >= 2 && isDir(body[body.length - 1])) {
    postDir = DIRECTIONALS[body[body.length - 1]];
    body = body.slice(0, -1);
  }
  const leftover = [...tail, ...trailing];
  if (leftover.length) {
    const loc = parseLocality(leftover);
    if (loc.understood) {
      if (loc.zip) {
        if (parsedZip && parsedZip !== loc.zip) isClean = false;
        parsedZip = parsedZip || loc.zip;
      }
    } else {
      isClean = false;
    }
  }
  // Without a street type, a city typed after the name cannot be separated from the name: strip a
  // trailing state/ZIP so the name relation can still be judged, but mark the parse unclean.
  if (suffixAt < 0 && body.length >= 2) {
    const last = body[body.length - 1];
    if (isZip(last) || STATES.has(last)) {
      while (body.length > 1 && (isZip(body[body.length - 1]) || STATES.has(body[body.length - 1]))) {
        const t = body.pop()!;
        if (isZip(t) && !parsedZip) parsedZip = t.slice(0, 5);
      }
      isClean = false;
    }
  }

  // Pre-directional, only if a street name remains after it.
  let preDir = '';
  if (body.length >= 2 && isDir(body[0])) { preDir = DIRECTIONALS[body[0]]; body = body.slice(1); }

  // Words inside the name are normalized the same way as everywhere else ("Mountain View" → "mountain
  // vw", "Highway 60" → "hwy 60"), and a street that is just a number is an ordinal ("7" → "7th").
  let nameTokens = body.map((t) => DIRECTIONALS[t] ?? NAME_WORDS[t] ?? SUFFIXES[t] ?? t);
  if (nameTokens.length === 1 && /^\d+$/.test(nameTokens[0])) nameTokens = [ordinal(Number(nameTokens[0]))];
  const name = nameTokens.join(' ');
  if (!name || /[^a-z0-9 ]/.test(name)) isClean = false;
  const cleanName = name.replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

  return {
    number,
    name: cleanName,
    dir: [preDir, postDir].filter(Boolean).join(' '),
    suffix,
    unit: parsedUnit,
    zip: parsedZip,
    clean: isClean,
    tokens: [preDir, cleanName, suffix, postDir].filter(Boolean).join(' '),
  };
}

/**
 * Same, ambiguous or different property. Mirrors safety._property_relation exactly.
 *
 * Different only when something both sides state disagrees: house number, unit, ZIP, or a street part
 * (name, directional, type). A street part does not count as a disagreement when one side's street words
 * appear whole inside the other's ("E Mountain View" inside "E Mountain View Rd"): the parse may simply
 * have read the same words differently, so that is ambiguous at most.
 */
export function compareProperty(a: ParsedAddress, b: ParsedAddress): PropertyRelation {
  // No readable house number or street name ("Unit 4, 1700 W …", "1700-4 W …"): it could be any address
  // in its ZIP, so ambiguous when the ZIPs agree.
  if (!a.number || !b.number || !a.name || !b.name) return a.zip && a.zip === b.zip ? 'ambiguous' : 'different';
  let ambiguous = false;
  if (a.number !== b.number) {
    // "12a" / "12" / "12b": the same number with a letter on one side may be the same building.
    if (a.number.replace(/[a-z]+$/, '') !== b.number.replace(/[a-z]+$/, '')) return 'different';
    ambiguous = true;
  }
  const nested = containsWords(a.tokens, b.tokens) || containsWords(b.tokens, a.tokens);
  if (a.name !== b.name) {
    if ((a.name + ' ').startsWith(b.name + ' ') || (b.name + ' ').startsWith(a.name + ' ') || nested) ambiguous = true;
    // The same house number in the same ZIP under another street name: possibly a spelling we do not
    // know, so ambiguous rather than different.
    else if (a.zip && a.zip === b.zip) ambiguous = true;
    else return 'different';
  }
  if (a.dir && b.dir && a.dir !== b.dir) {
    if (!nested) return 'different';
    ambiguous = true;
  }
  if (a.suffix && b.suffix && a.suffix !== b.suffix) {
    // "Trail" / "Trails", "Court" / "Courts": singular and plural are ambiguous, never the same.
    const plural = a.suffix + 's' === b.suffix || b.suffix + 's' === a.suffix;
    if (!plural && !nested) return 'different';
    ambiguous = true;
  }
  if (a.unit && b.unit) {
    const u = unitRelation(a.unit, b.unit);
    if (u === 'different') return 'different';
    if (u === 'ambiguous') ambiguous = true;
  }
  if (a.zip && b.zip && a.zip !== b.zip) return 'different';
  for (const k of ['dir', 'suffix', 'unit', 'zip'] as const) {
    if (!a[k] !== !b[k]) ambiguous = true;
  }
  if (!a.clean || !b.clean) ambiguous = true;
  return ambiguous ? 'ambiguous' : 'same';
}

/** The fields stored on a job for the database's own comparison. */
export function propertyColumns(p: ParsedAddress) {
  return { number: p.number, name: p.name, dir: p.dir, suffix: p.suffix, unit: p.unit, zip: p.zip, tokens: p.tokens };
}
