import { createRouter, createWebHistory } from "vue-router";
import RunList from "./components/RunList.vue";
import RunDetail from "./components/RunDetail.vue";
import AnalyticsPage from "./components/AnalyticsPage.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: RunList },
    { path: "/runs/:id", component: RunDetail, props: true },
    { path: "/analytics", component: AnalyticsPage },
  ],
});
