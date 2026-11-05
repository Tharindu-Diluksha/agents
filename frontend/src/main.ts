import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { router } from "./router.js";
import "./styles.css";

import { loadCurrentUser } from "./auth.js";

// Sign-in first (redirects to Keycloak when needed), then render.
void loadCurrentUser().then(() => {
  const app = createApp(App);
  app.use(createPinia());
  app.use(router);
  app.mount("#app");
});
