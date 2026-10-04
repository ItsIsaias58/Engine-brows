// markup del modal de cloud sync. vive aparte de cloudsync.ts porque es
// HTML puro: ni red, ni estado, ni auth. el arbol de nodos se referencia por id
// desde attachCloudSyncModalListeners y updateModalState, asi que mover el
// markup aqui no cambia ningun select query.
import { svgIcon } from "../../core/ui/svgIcon";

/** @returns {string} el innerHTML del modal de cloud sync */
export function cloudSyncModalHtml(): string {
  return `                <h2 id="auth-title" style="text-align: center; margin-top: 0; margin-bottom: 15px;">login</h2>
                <div id="auth-forms" class="input-container">
                    <form id="login-form">
                        <label>username</label>
                        <input type="text" id="login-username" placeholder="enter username" autocomplete="username" minlength="3" maxlength="20">

                        <label style="margin-top: 15px;">password</label>
                        <div style="position: relative;">
                            <input type="password" id="login-password" placeholder="enter password" autocomplete="current-password" maxlength="128" style="width: 100%; padding-right: 35px; box-sizing: border-box;">
                            <span class="password-toggle" data-target="login-password" style="position: absolute; right: 10px; top: 59%; transform: translateY(-50%); cursor: pointer; color: var(--text-muted); font-size: 13px;">${svgIcon("IconEyeOpen")}</span>
                        </div>

                        <div style="text-align: center;">
                            <button type="submit" class="auth-action-btn" style="width: 50%; margin-top: 15px;">login</button>
                        </div>
                    </form>

                    <form id="register-form" style="display: none;">
                        <label>username</label>
                        <input type="text" id="reg-username" placeholder="create username" autocomplete="username" minlength="3" maxlength="20" pattern="[A-Za-z0-9_]+">
                        <div id="reg-username-feedback" style="font-size: 11px; color: var(--text-muted); margin-top: 4px; text-align: left; min-height: 14px;">3-20 chars, letters/numbers</div>

                        <label style="margin-top: 15px;">password</label>
                        <div style="position: relative;">
                            <input type="password" id="reg-password" placeholder="create password" autocomplete="new-password" minlength="6" maxlength="128" style="width: 100%; padding-right: 35px; box-sizing: border-box;">
                            <span class="password-toggle" data-target="reg-password" style="position: absolute; right: 10px; top: 59%; transform: translateY(-50%); cursor: pointer; color: var(--text-muted); font-size: 13px;">${svgIcon("IconEyeOpen")}</span>
                        </div>
                        <div id="reg-password-feedback" style="font-size: 11px; color: var(--text-muted); margin-top: 4px; text-align: left; min-height: 14px;">6+ characters</div>

                        <div style="text-align: center;">
                            <button type="submit" class="auth-action-btn" style="width: 60%; margin-top: 15px;">create account</button>
                            <p style="font-size: 11.5px; color: var(--status-error-text); margin-top: 10px; max-width: 80%; margin-left: auto; margin-right: auto;">
              save your password somewhere safe; all data will be forever lost if you forget it... /ᐠ - ˕ -マ
                            </p>
                        </div>
                    </form>

                    <div style="margin-top: 15px; margin-bottom: -20px; font-size: 13px; color: var(--text-muted); text-align: center;" id="auth-switch-container">
                        <span id="auth-prompt-text">don't have an account?</span> <span id="auth-action-text" class="link">create one!</span>
                    </div>
                    <div id="auth-error" style="color: var(--status-error-text); margin-top: 10px; font-size: 13px; min-height: 18px; text-align: center;"></div>
                </div>
                <div id="auth-logged-in" style="display: none; text-align: center;">
                    <p style="margin-bottom: 20px; font-size: 16px;">logged in as <span id="auth-user-display" style="color: var(--text-white);"></span></p>

                    <div style="margin-bottom: 20px;">
                        <span id="sync-status-indicator" style="color: var(--text-muted); font-size: 14px;">
                            synced!! (˵◝ ⩊  ◜˵マ
                        </span>
                    </div>

                    <button id="logout-btn" class="auth-action-btn auth-secondary-btn">
                        logout
                    </button>

                    <button id="delete-account-btn" class="auth-action-btn auth-secondary-btn">
                        delete account
                    </button>
                </div>
            <button id="close-cloudsync-modal" class="modal-close-btn">
                ${svgIcon("IconCrossMedium")}
            </button>
`;
}
