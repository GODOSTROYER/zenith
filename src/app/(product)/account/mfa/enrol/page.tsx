import { MfaFlow } from "../mfa-flow";
export default async function EnrolPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return <MfaFlow mode="enrol" returnTo={next} />;
}
