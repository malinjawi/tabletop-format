/** Check the browser's rendered resources, including assets hidden by onerror. */
export function observePreviewAssets(page) {
  const failures = [];
  const requests = new Set();
  const isAsset = url => /\/api\/games\/[^/]+\/assets\//.test(new URL(url).pathname);
  const onResponse = response => {
    if (!isAsset(response.url())) return;
    requests.add(response.url());
    if (response.status() >= 400) failures.push(`HTTP ${response.status()} ${response.url()}`);
  };
  const onFailure = request => {
    if (isAsset(request.url())) failures.push(`${request.failure()?.errorText} ${request.url()}`);
  };
  page.on("response", onResponse);
  page.on("requestfailed", onFailure);
  return {
    failures, requests,
    dispose() { page.off("response", onResponse); page.off("requestfailed", onFailure); },
  };
}

export async function inspectPreviewAssets(page, { selector = ".cf-card", expectedFonts = [] } = {}) {
  await page.locator(selector).first().waitFor({ state: "attached", timeout: 15000 });
  return page.evaluate(async ({ selector, expectedFonts }) => {
    const failures = [], urls = new Set(), backgrounds = new Set();
    const cards = [...document.querySelectorAll(selector)];
    const within = [...new Set(cards.flatMap(card => [card, ...card.querySelectorAll("*")]))];
    const bounded = promise => Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("resource decode timed out")), 10000)),
    ]);
    const decode = async (image, url) => {
      urls.add(url);
      try {
        await bounded(image.decode());
        if (!image.naturalWidth || !image.naturalHeight) throw new Error("empty decoded image");
      } catch (error) { failures.push(`Image decode failed: ${url}: ${error.message}`); }
    };
    // Lazy artwork outside the viewport must also be checked. Do not filter
    // display:none: Forge's fallback handler hides the very failures we need.
    await Promise.all(within.filter(element => element instanceof HTMLImageElement).map(async image => {
      image.loading = "eager";
      await decode(image, image.currentSrc || image.src);
    }));
    for (const element of within) {
      for (const pseudo of [null, "::before", "::after"]) {
        const value = getComputedStyle(element, pseudo).backgroundImage;
        for (const match of value.matchAll(/url\(["']?([^"')]+)["']?\)/g)) backgrounds.add(match[1]);
      }
      if (element instanceof SVGImageElement) {
        const href = element.href.baseVal;
        if (href) backgrounds.add(new URL(href, document.baseURI).href);
      }
    }
    await Promise.all([...backgrounds].map(async url => { const image = new Image(); image.src = url; await decode(image, url); }));
    await bounded(document.fonts.ready);
    const fonts = [...document.fonts].map(font => ({ family: font.family.replace(/^["']|["']$/g, ""), status: font.status }));
    for (const font of fonts.filter(font => font.status === "error")) failures.push(`Font decode failed: ${font.family}`);
    for (const family of expectedFonts) {
      if (!fonts.some(font => font.family === family && font.status === "loaded")) failures.push(`Required font did not load: ${family}`);
      if (!within.some(element => getComputedStyle(element).fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "") === family)) {
        failures.push(`Required font is not applied to a card: ${family}`);
      }
    }
    return { cards: cards.length, images: urls.size, backgrounds: backgrounds.size, urls: [...urls], fonts, failures };
  }, { selector, expectedFonts });
}
