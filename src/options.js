import {envSupportsDuplicateNames, envSupportsFlagGroups, envSupportsFlagV} from './utils.js';

const Accuracy = /** @type {const} */ ({
  strict: 'strict',
  default: 'default',
  loose: 'loose',
});

const EsVersion = {
  ES2018: 2018,
  ES2024: 2024,
  ES2025: 2025,
};

const Target = /** @type {const} */ ({
  auto: 'auto',
  ES2018: 'ES2018',
  ES2024: 'ES2024',
  ES2025: 'ES2025',
});

/**
Returns a complete set of options, with default values set for options that weren't provided.
@param {import('.').OnigurumaToEsOptions} [options]
@returns {Required<import('.').OnigurumaToEsOptions>}
*/
function getOptions(options) {
  if (options?.target !== undefined && !Target[options.target]) {
    throw new Error(`Unexpected target "${options.target}"`)
  }
  // Set default values
  const opts = {
    // Sets the level of emulation rigor/strictness.
    accuracy: 'default',
    // Disables advanced emulation that relies on returning a `RegExp` subclass, resulting in
    // certain patterns not being emulatable.
    avoidSubclass: false,
    // Oniguruma flags; a string with `i`, `m`, and `x` in any order (all optional). Oniguruma's
    // `m` is equivalent to JavaScript's `s` (`dotAll`).
    flags: '',
    // Include JavaScript flag `g` (`global`) in the result.
    global: false,
    // Include JavaScript flag `d` (`hasIndices`) in the result.
    hasIndices: false,
    // Specifies the recursion depth limit. Supported values are integers `2`–`100` and `null`. If
    // `null`, any use of recursion results in an error.
    maxRecursionDepth: 5,
    // JavaScript version used for generated regexes. Using `auto` detects the best value based on
    // your environment. Later targets allow faster processing, simpler generated source, and
    // support for additional features.
    target: 'auto',
    // Leave disabled unless the regex will be used in a TextMate grammar processor that merges
    // backreferences across `begin` and `end` patterns.
    tmGrammar: false,
    // Disables optimizations that simplify the pattern when it doesn't change the meaning.
    verbose: false,
    ...options,
  };
  if (opts.target === 'auto') {
    opts.target = (envSupportsDuplicateNames && envSupportsFlagGroups) ?
      'ES2025' :
      (envSupportsFlagV ? 'ES2024' : 'ES2018');
  }
  return opts;
}

export {
  Accuracy,
  EsVersion,
  getOptions,
  Target,
};
