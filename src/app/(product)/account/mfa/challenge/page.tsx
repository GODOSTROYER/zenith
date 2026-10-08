import { MfaFlow } from "../mfa-flow";
export default async function ChallengePage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return <MfaFlow mode="challenge" returnTo={next} />;
}
