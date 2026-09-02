// V9 (#61) F5: does this database produce trigrams for Thai?
//
// pg_trgm splits text into character trigrams using the database's LC_CTYPE. On
// a database created with `LC_CTYPE=C` -- what `initdb` gives you when the
// environment carries no locale, and what a slim container image usually has --
// Postgres treats every byte above ASCII as non-alphanumeric. Thai text
// therefore yields NO trigrams at all. Measured on PG17:
//
//   ctype=C           show_trgm('ประวัติ') -> {}
//   ctype=en_US.UTF-8 show_trgm('ประวัติ') -> {0x98e6ac,0xd4842f,...}  (7)
//
// The consequence is not an error. The GIN index is created, the query is
// accepted, and ILIKE still returns the RIGHT ROWS -- by scanning the whole
// table. Thai search silently loses its index, which is the "<1s at ten
// thousand messages" DoD failing while every test that checks only correctness
// stays green. Thai is this product's primary language, so that is the case
// that matters most.
//
// This module detects it and does not fix it: a database's collation is fixed
// at creation, so the repair is initdb/CREATE DATABASE with a UTF-8 locale plus
// a reindex -- an operator action, not something a migration may do behind
// their back. [-> O2 installer must force the locale at initdb]

const prisma = require("../prisma");

// A Thai word with no ASCII in it. If trigrams come back for this, they come
// back for Thai generally.
const THAI_PROBE = "ประวัติ";

/**
 * @param {{db?: Object}} [input]
 * @returns {Promise<{supported: boolean|null, ctype: string|null, trigrams: number|null, error?: string}>}
 */
async function thaiTrigramSupport({ db = prisma } = {}) {
  try {
    const [row] = await db.$queryRawUnsafe(
      `SELECT
         (SELECT datctype FROM pg_database WHERE datname = current_database()) AS ctype,
         array_length(public.show_trgm($1), 1) AS trigrams`,
      THAI_PROBE
    );
    // array_length of an empty array is NULL, not 0 -- and the C-locale case is
    // exactly the one that returns NULL, so it must not be read as "unknown".
    const trigrams = Number(row?.trigrams ?? 0);
    return { supported: trigrams > 0, ctype: row?.ctype ?? null, trigrams };
  } catch (error) {
    // pg_trgm absent, or a database that cannot answer. Reported rather than
    // guessed at: an operator can act on a message, not on silence.
    return {
      supported: null,
      ctype: null,
      trigrams: null,
      error: error.message,
    };
  }
}

/**
 * Boot report, same shape as reportRetrievalFilterSupport: say the actionable
 * thing once at startup, and return the finding so tests can assert on it.
 *
 * @param {{db?: Object, logger?: Console}} [input]
 */
async function reportChatSearchLocaleSupport({
  db = prisma,
  logger = console,
} = {}) {
  const result = await thaiTrigramSupport({ db });

  if (result.error) {
    logger.error(
      `\x1b[31m[chat-search]\x1b[0m could not determine whether this database produces trigrams for Thai: ${result.error}. ` +
        `This is a fault in the diagnostic, not a statement about your data — chat search returns correct results either way.`
    );
    return result;
  }

  if (result.supported === false) {
    logger.error(
      `\x1b[31m[chat-search]\x1b[0m this database has LC_CTYPE="${result.ctype}", so pg_trgm produces ZERO trigrams for Thai text. ` +
        `Chat history search still returns the correct rows, but it cannot use its index for Thai and scans the whole table — ` +
        `the "<1s at ten thousand messages" target does not hold for Thai. English search is unaffected. ` +
        `A database's collation is fixed at creation: recreate it with a UTF-8 locale (initdb --locale=en_US.UTF-8, or ` +
        `CREATE DATABASE ... LC_CTYPE 'en_US.UTF-8' TEMPLATE template0) and reindex.`
    );
  }

  return result;
}

module.exports = {
  THAI_PROBE,
  thaiTrigramSupport,
  reportChatSearchLocaleSupport,
};
