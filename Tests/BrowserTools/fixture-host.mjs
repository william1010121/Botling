// Synthetic test plugin only. Production site selectors/actions belong to Maintainer.
export function activate(ccb) {
  return ccb.browser.registerTool({id:'details',title:'Read task details',origin:'FIXTURE_ORIGIN'}, async scope => {
    const observe = () => ccb.browser.perform({...scope,operation:'observe'});
    let page = await observe();
    const button = page.targets.find(t => t.tag==='button' && t.text==='Open details');
    if (!button) throw Error('Fixture button not observed');
    await ccb.browser.perform({...scope,operation:'click',target:button.id});
    page = await observe();
    const detail = page.targets.find(t => t.tag==='p' && t.text.startsWith('Task Alpha'));
    if (!detail) throw Error('Fixture details not observed');
    const data = await ccb.browser.perform({...scope,operation:'extract',target:detail.id});
    let rejected = 0;
    for (const invalid of [{account:'wrong'}, {tab:'wrong'}, {origin:'https://elsewhere.invalid'}]) {
      try { await ccb.browser.perform({...scope,...invalid,operation:'observe'}); } catch { rejected++; }
    }
    if (rejected !== 3) throw Error('Scope guard failed');
    return {data, rejectedScopes:rejected};
  });
}
