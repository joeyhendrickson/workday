'use client';

import WebsiteScanner from '@/components/WebsiteScanner';

export default function Home() {
  return (
    <main className="min-h-screen bg-white" style={{ pointerEvents: 'auto' }}>
      <div className="container mx-auto px-4 py-8 lg:py-12">
        <header className="mb-10 text-center">
          <h1 className="text-5xl font-extrabold text-black mb-3">
            WorkDay Website Scanner
          </h1>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            Find CougarWeb and Colleague references across your site, then get Workday-based messaging updates and recommended copy.
          </p>
        </header>

        <div className="max-w-7xl mx-auto">
          <div className="bg-white rounded-2xl shadow-2xl p-6 lg:p-8 border-2 border-black">
            <WebsiteScanner />
          </div>
        </div>
      </div>
    </main>
  );
}
