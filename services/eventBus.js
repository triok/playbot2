// eventBus.js
import { EventEmitter } from 'events';

export const eventBus = new EventEmitter();
// Увеличим лимит слушателей (на случай, если много рынков)
eventBus.setMaxListeners(500);