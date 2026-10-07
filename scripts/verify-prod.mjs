// LEGACY, pre-auth script (TradePulse Pro, Sep 2026). It calls public Convex functions without
// signing in, or targets the old Convex hackathon deployment. The TradePulse Pay role guards
// refuse those calls, so this script no longer works. Kept for history only; it is not a
// verification command. See README "Legacy scripts".
async function checkProduction() {
  const url = 'https://brainy-skunk-440.convex.site';
  console.log('Testing live URL:', url);
  const res = await fetch(url);
  console.log('HTTP Status:', res.status, res.statusText);
  const text = await res.text();
  console.log('Content length:', text.length, 'bytes');
  console.log('Includes title:', text.includes('TradePulse Pro'));
  console.log('Includes root div:', text.includes('id="root"'));
  if (res.status === 200) {
    console.log('VERIFIED: Live Convex Static Hosting site is online and serving TradePulse Pro!');
  } else {
    process.exit(1);
  }
}
checkProduction();
