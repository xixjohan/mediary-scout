import { Suspense } from "react";
import { notFound } from "next/navigation";
import { WorkspaceNotFoundError } from "@media-track/workflow";
import { HomeView } from "../../page";
import { getActiveWorkspaceScope } from "../../../lib/workflow-runtime";

/**
 * Tree model: a specific drive's workspace. Same home surface as the root route,
 * scoped to this connected storage. Root ("/") is the account's PRIMARY drive;
 * additional drives live here. A storageId the account does not own → 404.
 *
 * All dynamic reads (params + the ownership-validating DB call) live INSIDE a
 * Suspense boundary so the static shell still prerenders — cacheComponents
 * forbids uncached data access outside <Suspense> (the "blocking-route" error).
 */
export default function WorkspaceHomePage({
  params,
  searchParams,
}: {
  params: Promise<{ storageId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <Suspense fallback={<div className="app-shell" />}>
      <ValidatedWorkspaceHome params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function ValidatedWorkspaceHome({
  params,
  searchParams,
}: {
  params: Promise<{ storageId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>> | undefined;
}) {
  const { storageId } = await params;
  try {
    // Up-front ownership validation; the data readers re-resolve the same scope.
    await getActiveWorkspaceScope(storageId);
  } catch (error) {
    if (error instanceof WorkspaceNotFoundError) {
      notFound();
    }
    throw error;
  }
  return <HomeView searchParams={searchParams} storageId={storageId} />;
}
