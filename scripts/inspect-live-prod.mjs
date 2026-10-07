// LEGACY, pre-auth script (TradePulse Pro, Sep 2026). It calls public Convex functions without
// signing in, or targets the old Convex hackathon deployment. The TradePulse Pay role guards
// refuse those calls, so this script no longer works. Kept for history only; it is not a
// verification command. See README "Legacy scripts".
async function check() {
  const html = await (await fetch('https://brainy-skunk-440.convex.site')).text();
  console.log('HTML length:', html.length);
  const matches = [...html.matchAll(/src=["'](\/assets\/[^"']+)["']/g)];
  console.log('Script matches:', matches.map(m => m[1]));
  for (const m of matches) {
    const jsUrl = 'https://brainy-skunk-440.convex.site' + m[1];
    console.log('Fetching:', jsUrl);
    const js = await (await fetch(jsUrl)).text();
    console.log('JS length:', js.length);
    console.log('Contains Lone Star:', js.includes('Lone Star'));
    console.log('Contains Austin Metro:', js.includes('Austin Metro'));
    console.log('Contains 555-0192:', js.includes('555-0192'));
    console.log('Contains Rosendin:', js.includes('Rosendin'));
    console.log('Contains Alterman:', js.includes('Alterman'));
    console.log('Contains capitalcitygrid:', js.includes('capitalcitygrid'));
  }
}
check().catch(console.error);
