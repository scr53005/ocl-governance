import Image from 'next/image';
import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 py-12">
      <div className="text-center space-y-6">
        {/* Title */}
        <div>
          <h1 className="text-4xl md:text-5xl font-bold text-gray-900 mb-2">
            OffChain Luxembourg asbl
          </h1>
          <p className="text-xl md:text-2xl text-gray-600">
            Governance dashboard
          </p>
        </div>

        {/* Responsive Logo Container */}
        <div className="flex justify-center items-center max-w-xs mx-auto">  {/* New: Flex container with max-width for mobile scaling */}
          <Image
            src="/images/OF-LUX.png"
            alt="OffChain Luxembourg Logo"
            width={438}  // Keep original for quality
            height={113}
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 438px"  // New: Responsive sizes (full on mobile, scales up)
            className="w-full h-auto rounded-lg shadow-lg object-contain"  // New: Full width in container, auto height, contain aspect ratio
          />
        </div>

        {/* Buttons */}
        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Link
            href="/voting"
            className="bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 px-6 rounded-lg shadow-md transition-colors duration-200 text-lg w-full sm:w-auto text-center"
          >
            Voting
          </Link>
          <Link
            href="/debt"
            className="bg-green-600 hover:bg-green-700 text-white font-semibold py-3 px-6 rounded-lg shadow-md transition-colors duration-200 text-lg w-full sm:w-auto text-center"
          >
            Reserve Ratio
          </Link>
        </div>
      </div>
    </div>
  );
}