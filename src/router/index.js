import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
    history: createWebHistory(import.meta.env.BASE_URL),

    routes: [
        {
            path: '/',
            component: () => import('@/views/pages/Landing.vue'),
            name: 'Yeeh Doh!!'
        }
    ]
});

export default router;
