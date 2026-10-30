import { InMemoryWorkflowRepository } from "../../src/persistence/repository.js";
import { runRepositoryContract } from "../fixtures/repository-contract.js";

runRepositoryContract("InMemory", { make: () => new InMemoryWorkflowRepository() });
