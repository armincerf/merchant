/**
 * Bot detection utility.
 *
 * Uses a single compiled regex that matches against known bot / crawler
 * User-Agent strings.  The check is case-insensitive.
 *
 * Empty or missing User-Agent values are treated as bots (legitimate
 * browsers always send a UA string).
 */

const BOT_PATTERN =
  /Googlebot|Bingbot|Slurp|DuckDuckBot|Baiduspider|YandexBot|Sogou|facebookexternalhit|Twitterbot|LinkedInBot|WhatsApp|Applebot|AhrefsBot|SemrushBot|DotBot|MJ12bot|crawler|spider|bot|headless|phantom|puppeteer|lighthouse|pagespeed/i;

/**
 * Returns `true` when the given User-Agent string looks like a bot, crawler,
 * or other automated client.
 *
 * @param userAgent - The raw User-Agent header value.
 * @returns Whether the request likely originates from a bot.
 */
export function isBot(userAgent: string | undefined | null): boolean {
  if (!userAgent || userAgent.trim() === '') {
    return true;
  }

  return BOT_PATTERN.test(userAgent);
}
