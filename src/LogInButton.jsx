import {motion} from 'framer-motion'

export default function LogInButton() {
    return (
        <motion.div
            className="fixed top-5 right-5 p-2 pl-4 pr-4 bg-panel border-border border-[0.5px] text-white text-lg font-mono rounded-lg"
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            transition={{ type: "spring", stiffness: 500, damping: 30}}
            onClick={() => window.location.href = "https://niqbit.com/login?redirect=https://sguess.niqbit.com" }
        >Log in</motion.div>
    )
}