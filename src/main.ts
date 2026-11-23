import { createApp } from 'vue';
import App from './App.vue';
import { installI18n } from './i18n.ts';
import { installPluginTheme } from './theme.ts';
import './styles.css';

installPluginTheme();
installI18n();

createApp(App).mount('#app');
