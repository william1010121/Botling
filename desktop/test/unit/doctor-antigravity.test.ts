import { expect, it, vi } from 'vitest';
import { Doctor } from '../../src/core/doctor';
import { DoctorCheck } from '../../src/contract/doctor';
it('Doctor includes optional Antigravity without starting a runtime or downloading', async () => {
  const run = vi.fn();
  const rows = await new Doctor({ locate: () => null, run }).check(false);
  const agy = rows.find(row => row.tool === 'antigravity');
  expect(agy).toMatchObject({ name: 'Antigravity', isRequired: false, minimum: '1.4.3', status: 'warning', auth: null });
  expect(DoctorCheck.safeParse(agy).success).toBe(true);
  expect(run).not.toHaveBeenCalled();
});
it('reports verified, invalid, and overriding runtimes without claiming Google sign-in', async () => {
  for (const valid of [true,false]) {
    const rows = await new Doctor({locate:()=>null,agy:()=>({saved:'/saved',override:'/override',effective:'/override',valid,message:valid?'Verified. Google sign-in not tested.':'hash mismatch'})}).check(false);
    const check=rows.find(row=>row.tool==='antigravity')!;
    expect(check).toMatchObject({status:valid?'ok':'warning',path:'/override',version:valid?'1.4.3':null,auth:null});
    expect(check.summary).toContain('BOTLING_AGY_ACP_PATH is active');
    expect(check.summary).toContain(valid?'Google sign-in not tested':'hash mismatch');
  }
});
