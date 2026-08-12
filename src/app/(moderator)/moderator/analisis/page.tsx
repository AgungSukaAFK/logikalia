import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { Header } from "@/components/layout/Header";
import { AnalisisClient } from "@/components/moderator/AnalisisClient";
import type { SkillBin } from "@/lib/rl/types";

const SOAL_PER_MODULE = 3;
const SKILL_RANK: Record<SkillBin, number> = { low: 0, medium: 1, high: 2 };

export interface AnalisisSistemData {
  avgSoalDiselesaikan: number;
  tingkatKeberhasilan: number;
  avgHintPerSiswa: number;
  perubahanLevel: { naik: number; tetap: number; turun: number };
  avgReward: number;
  totalPembaruanQValue: number;
  siswaSelesaiSemuaLevel: number;
  totalSiswaAktif: number;
  avgWaktuMenitPerSiswa: number;
  totalAdaptasiKesulitan: number;
}

export default async function ModeratorAnalisisPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: currentProfile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  const admin = createAdminClient();

  const [
    { data: profileRows },
    { data: moduleRows },
    { data: puzzleRows },
    { data: qTableRows },
  ] = await Promise.all([
    admin.from("profiles").select("id, role"),
    admin.from("modules").select("id, name"),
    admin.from("puzzles").select("id, module_id"),
    admin.from("q_tables").select("total_updates"),
  ]);

  const studentIds = new Set(
    (profileRows ?? [])
      .filter((p) => (p.role ?? "siswa") === "siswa")
      .map((p) => p.id as string),
  );

  const puzzleModuleMap = new Map<string, string>(
    (puzzleRows ?? []).map((p) => [p.id as string, p.module_id as string]),
  );
  const moduleIds = (moduleRows ?? []).map((m) => m.id as string);

  const { data: attemptRows } = await admin
    .from("attempts")
    .select("user_id, puzzle_id, solved, hints_used, time_taken_sec, reward");

  const attempts = (attemptRows ?? []).filter((a) =>
    studentIds.has(a.user_id as string),
  );

  const { data: rlEventRows } = await admin
    .from("rl_events")
    .select("user_id, module_id, state_before, state_after, action_taken, created_at")
    .order("created_at", { ascending: true });

  const rlEvents = (rlEventRows ?? []).filter((e) =>
    studentIds.has(e.user_id as string),
  );

  // --- Siswa aktif (punya minimal 1 attempt) ---
  const activeStudentIds = new Set(attempts.map((a) => a.user_id as string));
  const totalSiswaAktif = activeStudentIds.size;

  // --- 1. Rata-rata soal diselesaikan per siswa ---
  const solvedByUser = new Map<string, Set<string>>();
  for (const a of attempts) {
    if (!a.solved) continue;
    const userId = a.user_id as string;
    if (!solvedByUser.has(userId)) solvedByUser.set(userId, new Set());
    solvedByUser.get(userId)!.add(a.puzzle_id as string);
  }
  const totalSoalSolved = Array.from(solvedByUser.values()).reduce(
    (sum, set) => sum + set.size,
    0,
  );
  const avgSoalDiselesaikan =
    totalSiswaAktif > 0 ? totalSoalSolved / totalSiswaAktif : 0;

  // --- 2. Tingkat keberhasilan ---
  const totalAttempts = attempts.length;
  const totalSolvedAttempts = attempts.filter((a) => a.solved).length;
  const tingkatKeberhasilan =
    totalAttempts > 0 ? (totalSolvedAttempts / totalAttempts) * 100 : 0;

  // --- 3. Penggunaan hint rata-rata per siswa ---
  const totalHints = attempts.reduce(
    (sum, a) => sum + ((a.hints_used as number | null) ?? 0),
    0,
  );
  const avgHintPerSiswa = totalSiswaAktif > 0 ? totalHints / totalSiswaAktif : 0;

  // --- 4. Perubahan level (skill_bin awal vs akhir per siswa) ---
  const eventsByUser = new Map<string, typeof rlEvents>();
  for (const e of rlEvents) {
    const userId = e.user_id as string;
    if (!eventsByUser.has(userId)) eventsByUser.set(userId, []);
    eventsByUser.get(userId)!.push(e);
  }
  let naik = 0;
  let tetap = 0;
  let turun = 0;
  for (const userEvents of eventsByUser.values()) {
    if (userEvents.length === 0) continue;
    const first = userEvents[0];
    const last = userEvents[userEvents.length - 1];
    const awalBin = (first.state_before as { skill_bin?: SkillBin })
      ?.skill_bin;
    const akhirBin =
      (last.state_after as { skill_bin?: SkillBin } | null)?.skill_bin ??
      (last.state_before as { skill_bin?: SkillBin })?.skill_bin;
    if (!awalBin || !akhirBin) continue;
    const rankAwal = SKILL_RANK[awalBin];
    const rankAkhir = SKILL_RANK[akhirBin];
    if (rankAkhir > rankAwal) naik += 1;
    else if (rankAkhir < rankAwal) turun += 1;
    else tetap += 1;
  }

  // --- 5. Reward rata-rata ---
  const rewardValues = attempts
    .map((a) => a.reward as number | null)
    .filter((r): r is number => r !== null);
  const avgReward =
    rewardValues.length > 0
      ? rewardValues.reduce((sum, r) => sum + r, 0) / rewardValues.length
      : 0;

  // --- 6. Pembaruan Q-value ---
  const totalPembaruanQValue = (qTableRows ?? []).reduce(
    (sum, t) => sum + ((t.total_updates as number | null) ?? 0),
    0,
  );

  // --- 7. Jumlah siswa menyelesaikan seluruh level pembelajaran ---
  const puzzlesByUserModule = new Map<string, Set<string>>();
  for (const a of attempts) {
    const moduleId = puzzleModuleMap.get(a.puzzle_id as string);
    if (!moduleId) continue;
    const key = `${a.user_id}|${moduleId}`;
    if (!puzzlesByUserModule.has(key)) puzzlesByUserModule.set(key, new Set());
    puzzlesByUserModule.get(key)!.add(a.puzzle_id as string);
  }
  let siswaSelesaiSemuaLevel = 0;
  if (moduleIds.length > 0) {
    for (const userId of activeStudentIds) {
      const selesaiSemua = moduleIds.every((moduleId) => {
        const set = puzzlesByUserModule.get(`${userId}|${moduleId}`);
        return (set?.size ?? 0) >= SOAL_PER_MODULE;
      });
      if (selesaiSemua) siswaSelesaiSemuaLevel += 1;
    }
  }

  // --- 8. Rata-rata waktu penggunaan (menit/siswa) ---
  const totalTimeSec = attempts.reduce(
    (sum, a) => sum + ((a.time_taken_sec as number | null) ?? 0),
    0,
  );
  const avgWaktuMenitPerSiswa =
    totalSiswaAktif > 0 ? totalTimeSec / 60 / totalSiswaAktif : 0;

  // --- 9. Adaptasi tingkat kesulitan (perubahan action_taken berturut-turut) ---
  const eventsByUserModule = new Map<string, typeof rlEvents>();
  for (const e of rlEvents) {
    const key = `${e.user_id}|${e.module_id}`;
    if (!eventsByUserModule.has(key)) eventsByUserModule.set(key, []);
    eventsByUserModule.get(key)!.push(e);
  }
  let totalAdaptasiKesulitan = 0;
  for (const group of eventsByUserModule.values()) {
    for (let i = 1; i < group.length; i++) {
      if (group[i].action_taken !== group[i - 1].action_taken) {
        totalAdaptasiKesulitan += 1;
      }
    }
  }

  const data: AnalisisSistemData = {
    avgSoalDiselesaikan,
    tingkatKeberhasilan,
    avgHintPerSiswa,
    perubahanLevel: { naik, tetap, turun },
    avgReward,
    totalPembaruanQValue,
    siswaSelesaiSemuaLevel,
    totalSiswaAktif,
    avgWaktuMenitPerSiswa,
    totalAdaptasiKesulitan,
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <Header
        user={{
          id: user.id,
          email: user.email,
          display_name: currentProfile?.display_name,
          username: currentProfile?.username,
          avatar_seed: currentProfile?.avatar_seed,
          role: currentProfile?.role,
        }}
      />
      <AnalisisClient data={data} />
    </div>
  );
}
