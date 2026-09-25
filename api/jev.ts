import { handleJevRequest } from "../src/server/jevEvaluation";

export default {
  fetch(request: Request) {
    return handleJevRequest(request);
  },
};
