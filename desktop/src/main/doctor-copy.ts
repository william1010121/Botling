import { DoctorView, type DoctorCheck } from "../contract/doctor";

/** Copy only a repair command from the core's last check, never renderer-supplied text. */
export function copyDoctorFix(tool: DoctorCheck["tool"], view: DoctorView, writeText: (text: string) => void): { copied: boolean } {
  const fix = DoctorView.parse(view).checks.find(check => check.tool === tool)?.fix;
  if (!fix) return { copied: false };
  writeText(fix);
  return { copied: true };
}
