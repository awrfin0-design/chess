// Sign in / register forms.
import { h, api, toast } from '../util.js';

export function mount(root, { mode }, ctx) {
  const isLogin = mode === 'login';
  document.title = `${isLogin ? 'Sign in' : 'Register'} · Rookery`;
  const error = h('p.form-error', { role: 'alert' });
  const username = h('input', { name: 'username', autocomplete: 'username', required: true, minLength: 3, maxLength: 20, autofocus: true, id: 'f-user' });
  const password = h('input', { name: 'password', type: 'password', autocomplete: isLogin ? 'current-password' : 'new-password', required: true, minLength: isLogin ? 1 : 6, id: 'f-pass' });
  const submit = h('button.btn.big', { type: 'submit' }, isLogin ? 'Sign in' : 'Create account');
  const form = h('form.card.auth', {
    on: {
      submit: async (e) => {
        e.preventDefault();
        error.textContent = '';
        submit.disabled = true;
        try {
          await api(isLogin ? '/api/login' : '/api/register', { username: username.value.trim(), password: password.value });
          await ctx.refreshMe();
          ctx.reconnect();
          toast(isLogin ? `Welcome back, ${ctx.me.username}!` : `Welcome to Rookery, ${ctx.me.username}!`, 'success');
          ctx.navigate('/');
        } catch (err) {
          error.textContent = err.message;
        } finally {
          submit.disabled = false;
        }
      },
    },
  },
  h('h1', isLogin ? 'Sign in' : 'Register'),
  h('label', { for: 'f-user' }, 'Username'), username,
  isLogin ? null : h('p.hint', '3–20 characters: letters, numbers, _ and -'),
  h('label', { for: 'f-pass' }, 'Password'), password,
  isLogin ? null : h('p.hint', 'At least 6 characters'),
  error,
  submit,
  h('p.muted.center', isLogin ? ['New here? ', h('a', { href: '/register' }, 'Create an account')] : ['Already registered? ', h('a', { href: '/login' }, 'Sign in')]),
  ctx.guestName ? h('p.muted.center.small', `You're currently playing as ${ctx.guestName}. You can keep playing casual games without an account.`) : null);
  root.append(form);
  setTimeout(() => username.focus(), 0);
}
