import { notFound } from "next/navigation";
import { WorkspaceNotFoundError } from "@media-track/workflow";
import { HomeView } from "../../page";
import { getActiveWorkspaceScope } from "../../../lib/workflow-runtime";

/**
 * Tree model: a specific drive's workspace. Same home surface as the root route,
 * but its library/search awareness is scoped to this connected storage. The root
 * route ("/") is the account's PRIMARY drive; additional drives live here.
 * A storageId the account does not own → 404.
 */
export default async function WorkspaceHomePage({
  params,
  searchParams,
}: {
  params: Promise<{ storageId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
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
