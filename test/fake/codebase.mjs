// The mod's codebase.js for the tests: the real module, with every call that would reach
// Codebase, the keychain or a local checkout answered from the mock data (demo.mjs).
export * from "../../mods/codebasehq/codebase.js";
export {
  loadCredentials, saveCredentials, forgetCredentials, repoOf, projects, choices, ticketPage, ticketDetail,
  ticketNotes, noteCommits, accountUsers, downloadAvatars, updateTicket, postNote, createTicket, findClone,
  commitDiff, downloadUpload, repositories, cloneRepository, findProjectCheckout, chooseFiles,
} from "./demo.mjs";
