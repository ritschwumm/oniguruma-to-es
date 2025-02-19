import {getOptions} from './options.js';
import {AstAssertionKinds, AstCharacterSetKinds, AstTypes, isLookaround} from './parse.js';
import {traverse} from './traverse.js';
import {getIgnoreCaseMatchChars, JsUnicodePropertiesPostEs2018, UnicodePropertiesWithSpecificCase} from './unicode.js';
import {cp, getNewCurrentFlags, isMinTarget, r} from './utils.js';

/**
Generates a Regex+ compatible `pattern`, `flags`, and `options` from a Regex+ AST.
@param {import('./transform.js').RegexAst} ast
@param {import('.').OnigurumaToEsOptions} [options]
@returns {{
  pattern: string;
  flags: string;
  options: Object;
}}
*/
function generate(ast, options) {
  const opts = getOptions(options);
  const minTargetEs2024 = isMinTarget(opts.target, 'ES2024');
  const minTargetEs2025 = isMinTarget(opts.target, 'ES2025');
  const rDepth = opts.maxRecursionDepth;
  if (rDepth !== null && (!Number.isInteger(rDepth) || rDepth < 2 || rDepth > 100)) {
    throw new Error('Invalid maxRecursionDepth; use 2-100 or null');
  }

  // If the output can't use flag groups, we need a pre-pass to check for the use of chars with
  // case in case sensitive/insensitive states. This minimizes the need for case expansions (though
  // expansions are lossless, even given Unicode case complexities) and allows supporting case
  // insensitive backrefs in more cases
  // [TODO] Consider gathering this data in the transformer's final traversal to avoid work here
  let hasCaseInsensitiveNode = null;
  let hasCaseSensitiveNode = null;
  if (!minTargetEs2025) {
    const iStack = [ast.flags.ignoreCase];
    traverse({node: ast}, {
      getCurrentModI: () => iStack.at(-1),
      popModI() {iStack.pop()},
      pushModI(isIOn) {iStack.push(isIOn)},
      setHasCasedChar() {
        if (iStack.at(-1)) {
          hasCaseInsensitiveNode = true;
        } else {
          hasCaseSensitiveNode = true;
        }
      },
    }, FlagModifierVisitor);
  }

  const appliedGlobalFlags = {
    dotAll: ast.flags.dotAll,
    // - Turn global flag i on if a case insensitive node was used and no case sensitive nodes were
    //   used (to avoid unnecessary node expansion).
    // - Turn global flag i off if a case sensitive node was used (since case sensitivity can't be
    //   forced without the use of ES2025 flag groups)
    ignoreCase: !!((ast.flags.ignoreCase || hasCaseInsensitiveNode) && !hasCaseSensitiveNode),
  };
  let lastNode = null;
  const state = {
    accuracy: opts.accuracy,
    appliedGlobalFlags,
    captureFlagIMap: new Map(),
    currentFlags: {
      dotAll: ast.flags.dotAll,
      ignoreCase: ast.flags.ignoreCase,
    },
    groupNames: new Set(),
    inCharClass: false,
    lastNode,
    maxRecursionDepth: rDepth,
    useAppliedIgnoreCase: !!(!minTargetEs2025 && hasCaseInsensitiveNode && hasCaseSensitiveNode),
    useDuplicateNames: minTargetEs2025,
    useFlagMods: minTargetEs2025,
    useFlagV: minTargetEs2024,
    usePostEs2018Properties: minTargetEs2024,
    verbose: opts.verbose,
  };
  function gen(node) {
    state.lastNode = lastNode;
    lastNode = node;
    switch (node.type) {
      case AstTypes.Regex:
        // Final result is an object; other node types return strings
        return {
          pattern: gen(node.pattern),
          flags: gen(node.flags),
          options: {...node.options},
        };
      case AstTypes.Alternative:
        return node.elements.map(gen).join('');
      case AstTypes.Assertion:
        return genAssertion(node, state, gen);
      case AstTypes.Backreference:
        return genBackreference(node, state);
      case AstTypes.CapturingGroup:
        return genCapturingGroup(node, state, gen);
      case AstTypes.Character:
        return genCharacter(node, state);
      case AstTypes.CharacterClass:
        return genCharacterClass(node, state, gen);
      case AstTypes.CharacterClassIntersection:
        if (!state.useFlagV) {
          throw new Error('Use of class intersection requires min target ES2024');
        }
        return node.classes.map(gen).join('&&');
      case AstTypes.CharacterClassRange:
        return genCharacterClassRange(node, state);
      case AstTypes.CharacterSet:
        return genCharacterSet(node, state);
      case AstTypes.Flags:
        return genFlags(node, state);
      case AstTypes.Group:
        return genGroup(node, state, gen);
      case AstTypes.Pattern:
        return node.alternatives.map(gen).join('|');
      case AstTypes.Quantifier:
        return gen(node.element) + getQuantifierStr(node);
      case AstTypes.Recursion:
        return genRecursion(node, state);
      default:
        // Node types `Directive`, `Subroutine`, and `VariableLengthCharacterSet` are never
        // included in transformer output
        throw new Error(`Unexpected node type "${node.type}"`);
    }
  }

  const result = gen(ast);
  if (!minTargetEs2024) {
    // Switch from flag v to u. By default, Regex+ implicitly chooses; control it instead
    delete result.options.force.v;
    result.options.disable.v = true;
    result.options.unicodeSetsPlugin = null;
  }
  return result;
}

const FlagModifierVisitor = {
  AnyGroup: {
    enter({node}, state) {
      const currentModI = state.getCurrentModI();
      state.pushModI(
        node.flags ?
          getNewCurrentFlags({ignoreCase: currentModI}, node.flags).ignoreCase :
          currentModI
      );
    },
    exit(_, state) {
      state.popModI();
    },
  },
  Backreference(_, state) {
    // Can't know for sure, so assume the backref will include chars with case (best that could be
    // done is not calling `setHasCasedChar` if the reffed group doesn't contain a char with case
    // or most kinds of char sets)
    state.setHasCasedChar();
  },
  Character({node}, state) {
    if (charHasCase(cp(node.value))) {
      state.setHasCasedChar();
    }
  },
  CharacterClassRange({node, skip}, state) {
    skip();
    if (getCasesOutsideCharClassRange(node, {firstOnly: true}).length) {
      state.setHasCasedChar();
    }
  },
  CharacterSet({node}, state) {
    if (
      node.kind === AstCharacterSetKinds.property &&
      UnicodePropertiesWithSpecificCase.has(node.value)
    ) {
      state.setHasCasedChar();
    }
  },
};

const BaseEscapeChars = new Set([
  '$', '(', ')', '*', '+', '.', '?', '[', '\\', ']', '^', '{', '|', '}',
]);
const CharClassEscapeChars = new Set([
  '-', '\\', ']', '^',
]);
const CharClassEscapeCharsFlagV = new Set([
  '(', ')', '-', '/', '[', '\\', ']', '^', '{', '|', '}',
  // Double punctuators; also includes already-listed `-` and `^`
  '!', '#', '$', '%', '&', '*', '+', ',', '.', ':', ';', '<', '=', '>', '?', '@', '`', '~',
]);
const CharCodeEscapeMap = new Map([
  [ 9, r`\t`], // horizontal tab
  [10, r`\n`], // line feed
  [11, r`\v`], // vertical tab
  [12, r`\f`], // form feed
  [13, r`\r`], // carriage return
  [0x2028, r`\u2028`], // line separator
  [0x2029, r`\u2029`], // paragraph separator
  [0xFEFF, r`\uFEFF`], // ZWNBSP/BOM
]);

const casedRe = /^\p{Cased}$/u;
function charHasCase(char) {
  return casedRe.test(char);
}

function genAssertion(node, _, gen) {
  const {kind, negate, alternatives} = node;
  if (isLookaround(node)) {
    const prefix = `${kind === AstAssertionKinds.lookahead ? '' : '<'}${negate ? '!' : '='}`;
    return `(?${prefix}${alternatives.map(gen).join('|')})`;
  }
  // Can always use `^` and `$` for string boundaries since JS flag m is never relied on; Onig uses
  // different line break chars
  if (kind === AstAssertionKinds.string_end) {
    return '$';
  }
  if (kind === AstAssertionKinds.string_start) {
    return '^';
  }
  // Kinds `line_end`, `line_start`, `search_start`, `string_end_newline`, and `word_boundary` are
  // never included in transformer output
  throw new Error(`Unexpected assertion kind "${kind}"`);
}

function genBackreference({ref}, state) {
  if (typeof ref !== 'number') {
    throw new Error('Unexpected named backref in transformed AST');
  }
  if (
    !state.useFlagMods &&
    state.accuracy === 'strict' &&
    state.currentFlags.ignoreCase &&
    !state.captureFlagIMap.get(ref)
  ) {
    throw new Error('Use of case-insensitive backref to case-sensitive group requires target ES2025 or non-strict accuracy');
  }
  return '\\' + ref;
}

function genCapturingGroup({name, number, alternatives}, state, gen) {
  if (name) {
    if (state.groupNames.has(name)) {
      if (!state.useDuplicateNames) {
        // Keep the name only in the first alternation path that used it; the transformer already
        // stripped all but the last duplicate name per alternation path
        name = null;
      }
    } else {
      state.groupNames.add(name);
    }
  }
  state.captureFlagIMap.set(number, state.currentFlags.ignoreCase);
  return `(${name ? `?<${name}>` : ''}${alternatives.map(gen).join('|')})`;
}

function genCharacter({value}, state) {
  const char = cp(value);
  const escaped = getCharEscape(value, {
    isAfterBackref: state.lastNode.type === AstTypes.Backreference,
    inCharClass: state.inCharClass,
    useFlagV: state.useFlagV,
  });
  if (escaped !== char) {
    return escaped;
  }
  if (state.useAppliedIgnoreCase && state.currentFlags.ignoreCase && charHasCase(char)) {
    const cases = getIgnoreCaseMatchChars(char);
    return state.inCharClass ?
      cases.join('') :
      (cases.length > 1 ? `[${cases.join('')}]` : cases[0]);
  }
  return char;
}

function genCharacterClass({negate, parent, elements}, state, gen) {
  if (
    !negate &&
    ( // Allows many nested classes to work with `target` ES2018 which doesn't support nesting
      (!state.useFlagV || !state.verbose) &&
      parent.type === AstTypes.CharacterClass &&
      elements[0].type !== AstTypes.CharacterClassIntersection
    ) ||
    ( !state.verbose &&
      parent.type === AstTypes.CharacterClassIntersection &&
      elements.length === 1 &&
      elements[0].type !== AstTypes.CharacterClassRange
    )
  ) {
    // Remove unnecessary nesting; unwrap kids into the parent char class. Some basic char class
    // optimization has already been done in the parser
    return elements.map(gen).join('');
  }
  if (!state.useFlagV && parent.type === AstTypes.CharacterClass) {
    throw new Error('Use of nested character class requires min target ES2024');
  }
  state.inCharClass = true;
  const result = `[${negate ? '^' : ''}${elements.map(gen).join('')}]`;
  state.inCharClass = false;
  return result;
}

function genCharacterClassRange(node, state) {
  const min = node.min.value;
  const max = node.max.value;
  const escOpts = {
    isAfterBackref: false,
    inCharClass: true,
    useFlagV: state.useFlagV,
  };
  const minStr = getCharEscape(min, escOpts);
  const maxStr = getCharEscape(max, escOpts);
  let extraChars = '';
  if (state.useAppliedIgnoreCase && state.currentFlags.ignoreCase) {
    // [TODO] Avoid duplication by considering other chars in the parent char class when expanding
    const charsOutsideRange = getCasesOutsideCharClassRange(node);
    const ranges = getCodePointRangesFromChars(charsOutsideRange);
    ranges.forEach(value => {
      extraChars += Array.isArray(value) ?
        `${getCharEscape(value[0], escOpts)}-${getCharEscape(value[1], escOpts)}` :
        getCharEscape(value, escOpts);
    });
  }
  // Create the range without calling `gen` on the `min`/`max` kids
  return `${minStr}-${maxStr}${extraChars}`;
}

function genCharacterSet({kind, negate, value, key}, state) {
  if (kind === AstCharacterSetKinds.dot) {
    return state.currentFlags.dotAll ?
      ((state.appliedGlobalFlags.dotAll || state.useFlagMods) ? '.' : '[^]') :
      // Onig's only line break char is line feed, unlike JS
      r`[^\n]`;
  }
  if (kind === AstCharacterSetKinds.digit) {
    return negate ? r`\D` : r`\d`;
  }
  if (kind === AstCharacterSetKinds.property) {
    if (!state.usePostEs2018Properties && JsUnicodePropertiesPostEs2018.has(value)) {
      throw new Error(`Unicode property "${value}" unavailable in target ES2018`);
    }
    if (
      state.useAppliedIgnoreCase &&
      state.currentFlags.ignoreCase &&
      UnicodePropertiesWithSpecificCase.has(value)
    ) {
      // Support for this would require heavy Unicode data. Could change e.g. `\p{Lu}` to `\p{LC}`
      // if not using strict `accuracy` (since it's close but not 100%), but this wouldn't work
      // for e.g. `\p{Lt}`, and in any case, it's probably user error if using these case-specific
      // props case-insensitively
      throw new Error(`Unicode property "${value}" can't be case-insensitive when other chars have specific case`);
    }
    return `${negate ? r`\P` : r`\p`}{${key ? `${key}=` : ''}${value}}`;
  }
  if (kind === AstCharacterSetKinds.word) {
    return negate ? r`\W` : r`\w`;
  }
  // Kinds `hex`, `posix`, and `space` are never included in transformer output
  throw new Error(`Unexpected character set kind "${kind}"`);
}

function genFlags(node, state) {
  return (
    // The transformer should never turn on the properties for flags d, g, and m since Onig doesn't
    // have equivs. Flag m is never relied on since Onig uses different line break chars than JS
    // (node.hasIndices ? 'd' : '') +
    // (node.global ? 'g' : '') +
    // (node.multiline ? 'm' : '') +
    (state.appliedGlobalFlags.ignoreCase ? 'i' : '') +
    (node.dotAll ? 's' : '') +
    (node.sticky ? 'y' : '')
    // Regex+ doesn't allow explicitly adding flags it handles implicitly, so there are no
    // `unicode` (flag u) or `unicodeSets` (flag v) props; those flags are added separately
  );
}

function genGroup({atomic, flags, parent, alternatives}, state, gen) {
  const currentFlags = state.currentFlags;
  if (flags) {
    state.currentFlags = getNewCurrentFlags(currentFlags, flags);
  }
  const contents = alternatives.map(gen).join('|');
  const result = (
    !state.verbose &&
    alternatives.length === 1 &&
    parent.type !== AstTypes.Quantifier &&
    !atomic &&
    (!state.useFlagMods || !flags)
   ) ? contents : `(?${getGroupPrefix(atomic, flags, state.useFlagMods)}${contents})`;
  state.currentFlags = currentFlags;
  return result;
}

function genRecursion({ref}, state) {
  const rDepth = state.maxRecursionDepth;
  if (!rDepth) {
    throw new Error('Use of recursion disabled');
  }
  if (state.accuracy === 'strict') {
    throw new Error('Use of recursion requires non-strict accuracy due to depth limit');
  }
  // Using the syntax supported by `regex-recursion`
  return ref === 0 ? `(?R=${rDepth})` : r`\g<${ref}&R=${rDepth}>`;
}

/**
Given a `CharacterClassRange` node, returns an array of chars that are a case variant of a char in
the range, and aren't already in the range.
*/
function getCasesOutsideCharClassRange(node, options) {
  const firstOnly = !!options?.firstOnly;
  const min = node.min.value;
  const max = node.max.value;
  const found = [];
  // Avoid unneeded work. Assumptions (per Unicode 16):
  // - No case variants cross the Basic Multilingual Plane boundary
  // - No cased chars appear beyond the Supplementary Multilingual Plane
  if ((min < 65 && (max === 0xFFFF || max >= 0x1FFFF)) || (min === 0x10000 && max >= 0x1FFFF)) {
    return found;
  }
  for (let i = min; i <= max; i++) {
    const char = cp(i);
    if (!charHasCase(char)) {
      continue;
    }
    const charsOutsideRange = getIgnoreCaseMatchChars(char).filter(caseOfChar => {
      const num = caseOfChar.codePointAt(0);
      return num < min || num > max;
    });
    if (charsOutsideRange.length) {
      found.push(...charsOutsideRange);
      if (firstOnly) {
        break;
      }
    }
  }
  return found;
}

// This shouldn't modifiy any char that has case
function getCharEscape(codePoint, {isAfterBackref, inCharClass, useFlagV}) {
  if (CharCodeEscapeMap.has(codePoint)) {
    return CharCodeEscapeMap.get(codePoint);
  }
  if (
    // Control chars, etc.; condition modeled on the Chrome developer console's display for strings
    codePoint < 32 || (codePoint > 126 && codePoint < 160) ||
    // Unicode planes 4-16; unassigned, special purpose, and private use area
    codePoint > 0x3FFFF ||
    // Avoid corrupting a preceding backref by immediately following it with a literal digit
    (isAfterBackref && isDigitCharCode(codePoint))
  ) {
    // Don't convert codePoint `0` to `\0` since that's corruptible by following literal digits
    return codePoint > 0xFF ?
      `\\u{${codePoint.toString(16).toUpperCase()}}` :
      `\\x${codePoint.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  const escapeChars = inCharClass ?
    (useFlagV ? CharClassEscapeCharsFlagV : CharClassEscapeChars) :
    BaseEscapeChars;
  const char = cp(codePoint);
  return (escapeChars.has(char) ? '\\' : '') + char;
}

function getCodePointRangesFromChars(chars) {
  const codePoints = chars.map(char => char.codePointAt(0)).sort((a, b) => a - b);
  const values = [];
  let start = null;
  for (let i = 0; i < codePoints.length; i++) {
    if (codePoints[i + 1] === codePoints[i] + 1) {
      start ??= codePoints[i];
    } else if (start === null) {
      values.push(codePoints[i]);
    } else {
      values.push([start, codePoints[i]]);
      start = null;
    }
  }
  return values;
}

function getGroupPrefix(atomic, flagMods, useFlagMods) {
  if (atomic) {
    return '>';
  }
  let mods = '';
  if (flagMods && useFlagMods) {
    const {enable, disable} = flagMods;
    mods =
      (enable?.ignoreCase ? 'i' : '') +
      (enable?.dotAll ? 's' : '') +
      (disable ? '-' : '') +
      (disable?.ignoreCase ? 'i' : '') +
      (disable?.dotAll ? 's' : '');
  }
  return `${mods}:`;
}

function getQuantifierStr({min, max, greedy, possessive}) {
  let base;
  if (!min && max === 1) {
    base = '?';
  } else if (!min && max === Infinity) {
    base = '*';
  } else if (min === 1 && max === Infinity) {
    base = '+';
  } else if (min === max) {
    base = `{${min}}`;
  } else {
    base = `{${min},${max === Infinity ? '' : max}}`;
  }
  return base + (possessive ? '+' : (greedy ? '' : '?'));
}

function isDigitCharCode(value) {
  return value > 47 && value < 58;
}

export {
  generate,
};
