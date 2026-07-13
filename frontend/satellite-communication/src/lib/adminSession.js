import { computed, reactive } from "vue";
import { fetchAuthStatus, loginAsAdmin, logoutAdmin } from "./simulationAdapter";

const state = reactive({
  checked: false,
  loading: false,
  role: "guest",
  username: "",
});

function applyAuthPayload(payload) {
  state.checked = true;
  state.role = payload?.role || "guest";
  state.username = payload?.username || "";
}

export async function refreshAdminSession() {
  if (state.loading) {
    return state;
  }
  state.loading = true;
  try {
    const payload = await fetchAuthStatus();
    applyAuthPayload(payload);
    return state;
  } finally {
    state.loading = false;
  }
}

export async function adminLogin(credentials) {
  state.loading = true;
  try {
    const payload = await loginAsAdmin(credentials);
    applyAuthPayload(payload);
    return state;
  } finally {
    state.loading = false;
  }
}

export async function adminLogout() {
  state.loading = true;
  try {
    const payload = await logoutAdmin();
    applyAuthPayload(payload);
    return state;
  } finally {
    state.loading = false;
  }
}

export const adminSessionState = state;
export const isAdminLoggedIn = computed(() => state.role === "admin");
